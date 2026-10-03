import { StringDecoder } from "node:string_decoder";
import { RuntimeExecutionError } from "../errors.js";
import type { RuntimeRunInput } from "../types.js";
import {
  makeProcessRunTimeoutError,
  makeProcessStartTimeoutError,
  withProcessTimeouts,
} from "../timeouts.js";
import { launchNativeStdioProcess, type NativeProcessLaunchInput } from "./nativeProcessScope.js";

/** Shared batch lifecycle for a host-owned native unit. Provider completion is
 * interpreted by the caller only after native proof and drained output. */
export async function runNativeBatch<T>(options: {
  input: RuntimeRunInput;
  command: Omit<NativeProcessLaunchInput, "onOutput" | "signal" | "cwd">;
  stdin: string;
  runTimeoutMs?: number;
  line: (line: string) => void;
  complete: () => T;
  failure: (code: string, cause?: unknown) => RuntimeExecutionError;
}): Promise<T> {
  const { input, failure } = options;
  const execution = input.execution;
  const scope = execution?.nativeProcessScope;
  if (!scope) throw failure("scope_required");
  const signal = execution.abortController?.signal;
  if (signal?.aborted) throw failure("aborted");
  const child = await launchNativeStdioProcess(scope, {
    ...options.command,
    cwd: input.cwd ?? input.projectRoot ?? "",
    signal,
  });
  const timeouts = withProcessTimeouts(child, {
    startTimeoutMs: execution.startTimeoutMs,
    runTimeoutMs: options.runTimeoutMs,
  });
  const stdoutDecoder = new StringDecoder("utf8"),
    stderrDecoder = new StringDecoder("utf8");
  let buffer = "",
    bytesRead = 0;
  let failed: RuntimeExecutionError | undefined;
  const fail = (error: unknown) => {
    failed ??= error instanceof RuntimeExecutionError ? error : failure("callback_failed", error);
    child.kill();
  };
  const consume = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    if (failed || signal?.aborted) return;
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += bytes.length;
      if (bytesRead > 16 * 1024 * 1024) throw failure("output_overflow");
      if (stream === "stderr") {
        const text = stderrDecoder.write(bytes);
        if (text) execution.onStderr?.(text);
        return;
      }
      buffer += stdoutDecoder.write(bytes);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        options.line(line);
        if (signal?.aborted) return;
        newline = buffer.indexOf("\n");
      }
    } catch (error) {
      fail(error);
    }
  };
  const stdout = (chunk: Buffer | string) => consume("stdout", chunk);
  const stderr = (chunk: Buffer | string) => consume("stderr", chunk);
  const abort = () => {
    child.kill();
  };
  child.stdout.on("data", stdout);
  child.stderr.on("data", stderr);
  child.on("error", fail);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw failure("aborted");
    await new Promise<void>((resolve, reject) => {
      child.stdin.end(options.stdin, (error?: Error | null) => (error ? reject(error) : resolve()));
    });
    const exitCode = await child.waitForExit();
    timeouts.cleanup();
    if (failed) throw failed;
    if (signal?.aborted) throw failure("aborted");
    buffer += stdoutDecoder.end();
    if (buffer.trim()) options.line(buffer);
    const tail = stderrDecoder.end();
    if (tail) execution.onStderr?.(tail);
    if (signal?.aborted) throw failure("aborted");
    if (await timeouts.startTimedOut)
      throw makeProcessStartTimeoutError(execution.startTimeoutMs ?? 0);
    if (timeouts.runTimedOut) throw makeProcessRunTimeoutError(options.runTimeoutMs ?? 0);
    if (exitCode !== 0) throw failure("exit", { exitCode });
    return options.complete();
  } catch (error) {
    throw error instanceof RuntimeExecutionError ? error : failure("callback_failed", error);
  } finally {
    timeouts.cleanup();
    signal?.removeEventListener("abort", abort);
    child.stdout.off("data", stdout);
    child.stderr.off("data", stderr);
    child.off("error", fail);
    await child.stop();
  }
}
