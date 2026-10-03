import { StringDecoder } from "node:string_decoder";
import type { RuntimeStdioProcess } from "../../../supervision/nativeProcessScope.js";
import type {
  JsonRpcErrorEnvelope,
  JsonRpcNotificationEnvelope,
  JsonRpcRequestEnvelope,
  JsonRpcSuccessEnvelope,
} from "./protocol.js";

export interface JsonlRpcClientLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn?(context: Record<string, unknown>, message: string): void;
  error?(context: Record<string, unknown>, message: string): void;
}

export interface JsonlRpcClientOptions {
  runtimeId: string;
  profileId?: string | null;
  transport?: string;
  requestTimeoutMs?: number;
  logger?: JsonlRpcClientLogger;
  onNotification?: (notification: JsonRpcNotificationEnvelope) => void;
  onRequest?: (request: JsonRpcRequestEnvelope) => Promise<unknown> | unknown;
  onProtocolError?: (error: Error) => void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export class JsonlRpcResponseError extends Error {
  public readonly rpcId: string;
  public readonly rpcMethod: string;
  public readonly rpcCode: number | null;
  public readonly rpcData: unknown;

  constructor(input: {
    message: string;
    rpcId: string;
    rpcMethod: string;
    rpcCode?: number | null;
    rpcData?: unknown;
  }) {
    super(input.message);
    this.name = "JsonlRpcResponseError";
    this.rpcId = input.rpcId;
    this.rpcMethod = input.rpcMethod;
    this.rpcCode = input.rpcCode ?? null;
    this.rpcData = input.rpcData;
  }
}

export class JsonlRpcClient {
  private readonly childProcess: RuntimeStdioProcess;
  private readonly requestTimeoutMs: number;
  private readonly logger?: JsonlRpcClientLogger;
  private readonly runtimeId: string;
  private readonly profileId: string | null;
  private readonly transport: string;
  private readonly onNotification?: (notification: JsonRpcNotificationEnvelope) => void;
  private readonly onRequest?: (request: JsonRpcRequestEnvelope) => Promise<unknown> | unknown;
  private readonly onProtocolError?: (error: Error) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");

  private nextId = 0;
  private stdoutBuffer = "";
  private closed = false;

  constructor(childProcess: RuntimeStdioProcess, options: JsonlRpcClientOptions) {
    this.childProcess = childProcess;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger;
    this.runtimeId = options.runtimeId;
    this.profileId = options.profileId ?? null;
    this.transport = options.transport ?? "app-server";
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.onProtocolError = options.onProtocolError;

    childProcess.stdout.on("data", this.handleStdoutData);
    childProcess.on("error", this.handleChildError);
    childProcess.on("exit", this.handleChildExit);

    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        requestTimeoutMs: this.requestTimeoutMs,
      },
      "DEBUG [runtime:codex] Initialized stdio JSONL RPC client",
    );
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }

    const id = String(++this.nextId);
    const effectiveTimeoutMs = timeoutMs ?? this.requestTimeoutMs;
    const payload: JsonRpcRequestEnvelope = {
      id,
      method,
      params,
    };

    this.logger?.debug?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method,
        id,
        timeoutMs: effectiveTimeoutMs,
      },
      "DEBUG [runtime:codex] Sending JSONL RPC request",
    );

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for JSONL RPC response (${method})`));
      }, effectiveTimeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });

      this.writeMessage(payload).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }

    const payload: JsonRpcNotificationEnvelope = {
      method,
      params,
    };
    await this.writeMessage(payload);
  }

  close(reason = "client closed"): void {
    this.failPendingRequests(new Error(reason));
    this.detach();
    try {
      this.childProcess.stdin.end();
    } catch {
      // ignored
    }
  }

  private readonly handleStdoutData = (chunk: Buffer | string): void => {
    if (this.closed) {
      return;
    }

    this.stdoutBuffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  };

  private readonly handleChildError = (error: Error): void => {
    this.logger?.error?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        error: error.message,
      },
      "ERROR [runtime:codex] JSONL RPC child process emitted error",
    );
    this.failPendingRequests(error);
    this.detach();
  };

  private readonly handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const error = new Error(
      `Codex app-server process exited while RPC requests were pending (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        pendingRequestCount: this.pending.size,
        code,
        signal,
      },
      "WARN [runtime:codex] JSONL RPC child process exited",
    );
    this.failPendingRequests(error);
    this.detach();
  };

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          parseError: error instanceof Error ? error.message : String(error),
        },
        "WARN [runtime:codex] Failed to parse JSONL RPC message",
      );
      const protocolError = new Error("Malformed JSONL RPC payload from Codex app-server");
      this.failPendingRequests(protocolError);
      this.onProtocolError?.(protocolError);
      this.detach();
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          payloadType: typeof parsed,
        },
        "WARN [runtime:codex] Ignoring non-object JSONL RPC payload",
      );
      return;
    }

    const message = parsed as Record<string, unknown>;
    const method = readString(message.method);
    const id = message.id;

    if (method && id != null) {
      this.handleServerRequest(message as unknown as JsonRpcRequestEnvelope);
      return;
    }
    if (method) {
      this.onNotification?.(message as unknown as JsonRpcNotificationEnvelope);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "result") && id != null) {
      this.handleSuccess(message as unknown as JsonRpcSuccessEnvelope);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "error") && id != null) {
      this.handleError(message as unknown as JsonRpcErrorEnvelope);
      return;
    }

    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        keys: Object.keys(message),
      },
      "WARN [runtime:codex] Ignoring unknown JSONL RPC payload shape",
    );
  }

  private handleServerRequest(message: JsonRpcRequestEnvelope): void {
    this.logger?.warn?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method: message.method,
        id: message.id,
      },
      "WARN [runtime:codex] Received server-initiated JSONL RPC request",
    );

    if (!this.onRequest) {
      void this.writeMessage({
        id: message.id,
        error: {
          code: -32601,
          message: "Server-initiated request handler is not configured",
        },
      }).catch((error) => this.logServerRequestResponseError(message, error));
      return;
    }

    Promise.resolve()
      .then(() => this.onRequest?.(message))
      .then((result) =>
        this.writeMessage({
          id: message.id,
          result: result ?? {},
        }),
      )
      .catch((error) =>
        this.writeMessage({
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      )
      .catch((error) => this.logServerRequestResponseError(message, error));
  }

  private handleSuccess(message: JsonRpcSuccessEnvelope): void {
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          id,
        },
        "WARN [runtime:codex] Received JSONL RPC response for unknown request id",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(message.result);
  }

  private handleError(message: JsonRpcErrorEnvelope): void {
    const id = String(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.logger?.warn?.(
        {
          runtimeId: this.runtimeId,
          profileId: this.profileId,
          transport: this.transport,
          id,
          errorCode: message.error?.code ?? null,
        },
        "WARN [runtime:codex] Received JSONL RPC error for unknown request id",
      );
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    const errorMessage =
      message.error?.message ?? `Codex app-server JSONL RPC request failed (${pending.method})`;
    pending.reject(
      new JsonlRpcResponseError({
        message: errorMessage,
        rpcId: id,
        rpcMethod: pending.method,
        rpcCode: message.error?.code,
        rpcData: message.error?.data,
      }),
    );
  }

  private async writeMessage(message: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("JSONL RPC client is closed");
    }
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.childProcess.stdin.write(payload, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private logServerRequestResponseError(message: JsonRpcRequestEnvelope, error: unknown): void {
    this.logger?.error?.(
      {
        runtimeId: this.runtimeId,
        profileId: this.profileId,
        transport: this.transport,
        method: message.method,
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "ERROR [runtime:codex] Failed to send JSONL RPC response for server request",
    );
  }

  private failPendingRequests(error: Error): void {
    if (this.pending.size === 0) {
      return;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[request:${id}] ${error.message}`));
    }
    this.pending.clear();
  }

  private detach(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.childProcess.stdout.off("data", this.handleStdoutData);
    this.childProcess.off("error", this.handleChildError);
    this.childProcess.off("exit", this.handleChildExit);
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
