import { RuntimeExecutionError, classifyByHttpStatus } from "../../errors.js";
import { buildOpenAiCompatibleLimitSnapshot } from "../../openaiRateLimits.js";
import { buildRuntimeLimitEvent } from "../../limitEvents.js";
import { resolveProxyUrlForRequest } from "../../proxyEnv.js";
import { nativeProcessEnvironment } from "../../supervision/nativeProcessScope.js";
import { runNativeBatch } from "../../supervision/nativeBatch.js";
import type {
  RuntimeEvent,
  RuntimeRunInput,
  RuntimeSessionForkInput,
  RuntimeUsage,
} from "../../types.js";
import { nativeHttpFailure, parseNativeHttpFrame } from "./nativeProtocol.js";
import { NATIVE_HTTP_WORKER } from "./nativeWorker.js";

export function assertNativeHttpInput(input: RuntimeRunInput) {
  const allowed = new Set([
    "baseUrl",
    "agentApiBaseUrl",
    "apiKey",
    "apiKeyEnvVar",
    "headers",
    "httpReferer",
    "appTitle",
    "effort",
  ]);
  const execution = input.execution;
  const unsupported =
    (input.transport !== undefined && input.transport !== "api") ||
    input.sessionId ||
    input.resume ||
    (input as Partial<RuntimeSessionForkInput>).sourceSessionId ||
    !input.model ||
    execution?.hooks !== undefined ||
    execution?.environment !== undefined ||
    execution?.agentDefinitionName !== undefined ||
    execution?.bypassPermissions ||
    Object.keys(input.options ?? {}).some((key) => !allowed.has(key));
  if (unsupported) throw nativeHttpFailure("input_invalid");
}

/** Local text-only Chat Completions client. Native proof covers this client,
 * never a remote executor, inference cancellation or provider billing. */
export async function runNativeChatCompletion(
  input: RuntimeRunInput,
  request: {
    provider: "codex" | "openrouter";
    url: string;
    headers: Headers;
    body: Record<string, unknown>;
    stream: boolean;
  },
) {
  assertNativeHttpInput(input);
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw nativeHttpFailure("input_invalid");
  const blockedHeaders = [
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
  ];
  if (blockedHeaders.some((key) => request.headers.has(key)))
    throw nativeHttpFailure("input_invalid");
  const body = {
    ...request.body,
    ...(request.stream ? { stream_options: { include_usage: true } } : {}),
  };
  const proxy = resolveProxyUrlForRequest(url);
  const stdin = JSON.stringify({
    version: 1,
    cwd: input.cwd ?? input.projectRoot,
    url: url.toString(),
    headers: Object.fromEntries(request.headers),
    body,
    stream: request.stream,
    proxy,
  });
  if (Buffer.byteLength(stdin) > 1024 * 1024) throw nativeHttpFailure("input_limit");
  let headersSeen = false,
    finished = false,
    done = false,
    complete = false;
  let sessionId: string | null = null,
    outputText = "",
    usage: RuntimeUsage | null = null;
  const events: RuntimeEvent[] = [];
  const emit = (event: RuntimeEvent) => {
    events.push(event);
    input.execution?.onEvent?.(event);
  };
  return runNativeBatch({
    input,
    stdin,
    runTimeoutMs: input.execution?.runTimeoutMs,
    failure: nativeHttpFailure,
    command: {
      executable: process.execPath,
      args: ["--input-type=module", "-e", NATIVE_HTTP_WORKER, import.meta.resolve("undici")],
      environment: nativeProcessEnvironment({}),
    },
    line: (line) => {
      if (complete) throw nativeHttpFailure("protocol_invalid");
      const frame = parseNativeHttpFrame(line, request.stream);
      if (frame.kind === "headers") {
        if (headersSeen) throw nativeHttpFailure("protocol_invalid");
        headersSeen = true;
        const snapshot = buildOpenAiCompatibleLimitSnapshot(new Headers(frame.headers), {
          runtimeId: input.runtimeId,
          providerId: input.providerId ?? (request.provider === "codex" ? "openai" : "openrouter"),
          profileId: input.profileId ?? null,
          statusOverride: frame.status === 429 ? "blocked" : undefined,
        });
        if (snapshot) emit(buildRuntimeLimitEvent(snapshot));
        if (frame.status >= 300)
          throw new RuntimeExecutionError(
            "Native HTTP request failed",
            undefined,
            classifyByHttpStatus(frame.status) ?? "transport",
            {
              adapterCode: "native_http_status",
              httpStatus: frame.status,
              limitSnapshot: snapshot,
              retryAfterSeconds: snapshot?.retryAfterSeconds ?? null,
              retryAfterMs:
                snapshot?.retryAfterSeconds == null ? null : snapshot.retryAfterSeconds * 1000,
              resetAt: snapshot?.resetAt ?? null,
            },
          );
        return;
      }
      if (!headersSeen) throw nativeHttpFailure("protocol_invalid");
      if (frame.kind === "complete") {
        if (!sessionId || !finished || !usage || (request.stream && !done))
          throw nativeHttpFailure("incomplete");
        complete = true;
        return;
      }
      if (done) throw nativeHttpFailure("protocol_invalid");
      if (frame.kind === "done") {
        if (!request.stream || !finished || !usage) throw nativeHttpFailure("incomplete");
        done = true;
        return;
      }
      if (sessionId && frame.id !== sessionId) throw nativeHttpFailure("protocol_invalid");
      sessionId = frame.id;
      const accounting =
        finished &&
        !!frame.usage &&
        !usage &&
        !frame.text &&
        (!frame.hasChoice || (request.provider === "openrouter" && frame.finish));
      if ((finished && !accounting) || (frame.usage && usage))
        throw nativeHttpFailure("protocol_invalid");
      if (frame.finish) finished = true;
      if (frame.usage) {
        if (!finished) throw nativeHttpFailure("protocol_invalid");
        usage = frame.usage;
      }
      outputText += frame.text;
      if (request.stream && frame.text)
        emit({
          type: "stream:text",
          timestamp: new Date().toISOString(),
          message: frame.text,
          data: { text: frame.text },
        });
    },
    complete: () => {
      if (!complete) throw nativeHttpFailure("incomplete");
      return { outputText, sessionId, usage, events };
    },
  });
}
