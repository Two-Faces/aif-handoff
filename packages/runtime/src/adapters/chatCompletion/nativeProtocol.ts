import { RuntimeExecutionError } from "../../errors.js";
import type { RuntimeUsage } from "../../types.js";

export function nativeHttpFailure(code: string, cause?: unknown) {
  return new RuntimeExecutionError("Native HTTP attempt failed", cause, "transport", {
    adapterCode: "native_http_" + code,
  });
}
function invalid(): never {
  throw nativeHttpFailure("protocol_invalid");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function tokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function usageOf(value: unknown): RuntimeUsage | null {
  if (value === undefined || value === null) return null;
  const raw = record(value);
  const inputTokens = tokens(raw.prompt_tokens),
    outputTokens = tokens(raw.completion_tokens);
  const totalTokens =
    raw.total_tokens === undefined ? tokens(inputTokens + outputTokens) : tokens(raw.total_tokens);
  const cost = raw.cost ?? raw.costUsd;
  if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0))
    return invalid();
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}
type NativeHttpFrame =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | {
      kind: "payload";
      id: string;
      text: string;
      finish: boolean;
      usage: RuntimeUsage | null;
      hasChoice: boolean;
    }
  | { kind: "done" }
  | { kind: "complete" };

/** This projects response data only. It cannot authorize tools, file writes or
 * process stop. Incomplete/truncated/tool/refusal responses fail closed. */
export function parseNativeHttpFrame(line: string, stream: boolean): NativeHttpFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return invalid();
  }
  const frame = record(raw);
  if (frame.kind === "error" && frame.code === "worker_failed")
    throw nativeHttpFailure("worker_failed");
  if (frame.kind === "done" || frame.kind === "complete") return { kind: frame.kind };
  if (frame.kind === "headers") {
    const status = tokens(frame.status);
    if (status < 200 || status > 599) return invalid();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(record(frame.headers))) {
      if (typeof value !== "string" || (key !== "retry-after" && !key.startsWith("x-ratelimit-")))
        return invalid();
      headers[key] = value;
    }
    return { kind: frame.kind, status, headers };
  }
  if (frame.kind !== "payload") return invalid();
  const payload = record(frame.payload);
  if (payload.error !== undefined) throw nativeHttpFailure("provider_error");
  if (
    typeof payload.id !== "string" ||
    !payload.id ||
    !Array.isArray(payload.choices) ||
    payload.choices.length > 1
  )
    return invalid();
  const usage = usageOf(payload.usage);
  if (!payload.choices.length) {
    if (!stream || !usage) return invalid();
    return { kind: "payload", id: payload.id, text: "", finish: false, usage, hasChoice: false };
  }
  const choice = record(payload.choices[0]);
  if (choice.index !== 0) return invalid();
  const message = record(stream ? choice.delta : choice.message);
  const hasTools =
    message.tool_calls != null &&
    (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0);
  if (hasTools || message.function_call != null) throw nativeHttpFailure("tools_unsupported");
  if (message.refusal != null && message.refusal !== "") throw nativeHttpFailure("refused");
  const content = message.content;
  if (content != null && typeof content !== "string") return invalid();
  if (!stream && typeof content !== "string") return invalid();
  const finish = choice.finish_reason;
  if (finish != null && finish !== "stop") throw nativeHttpFailure("incomplete");
  if (!stream && finish !== "stop") throw nativeHttpFailure("incomplete");
  return {
    kind: "payload",
    id: payload.id,
    text: typeof content === "string" ? content : "",
    finish: finish === "stop",
    usage,
    hasChoice: true,
  };
}
