import { RuntimeExecutionError, classifyByHttpStatus } from "../../errors.js";

export function nativeOpenCodeFailure(code: string, cause?: unknown) {
  return new RuntimeExecutionError("Native OpenCode attempt failed", cause, "transport", {
    adapterCode: "native_opencode_" + code,
  });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw nativeOpenCodeFailure("protocol_invalid");
  return value as Record<string, unknown>;
}
export function parseNativeOpenCodeFrame(
  line: string,
):
  | { kind: "ready" }
  | { kind: "session"; id: string }
  | { kind: "result"; sessionId: string; text: string }
  | { kind: "complete" } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw nativeOpenCodeFailure("protocol_invalid");
  }
  const frame = record(value);
  if (frame.kind === "error" && frame.code === "http_status") {
    const status = frame.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 300 || status > 599)
      throw nativeOpenCodeFailure("protocol_invalid");
    throw new RuntimeExecutionError(
      "Native OpenCode HTTP request failed",
      undefined,
      classifyByHttpStatus(status) ?? "transport",
      { adapterCode: "native_opencode_http_status", httpStatus: status },
    );
  }
  if (
    frame.kind === "error" &&
    typeof frame.code === "string" &&
    [
      "worker_failed",
      "version_unsupported",
      "server_exit",
      "server_output_limit",
      "server_start_timeout",
      "http_status",
      "response_limit",
      "managed_config",
      "config_mismatch",
    ].includes(frame.code)
  )
    throw nativeOpenCodeFailure(frame.code);
  if (frame.kind === "ready" || frame.kind === "complete") return { kind: frame.kind };
  if (
    frame.kind === "session" &&
    typeof frame.id === "string" &&
    /^ses_[a-zA-Z0-9]+$/.test(frame.id)
  )
    return { kind: frame.kind, id: frame.id };
  if (frame.kind === "result") {
    const payload = record(frame.payload),
      info = record(payload.info),
      time = record(info.time);
    if (
      typeof info.id !== "string" ||
      !/^msg_[a-zA-Z0-9]+$/.test(info.id) ||
      typeof info.sessionID !== "string" ||
      !/^ses_[a-zA-Z0-9]+$/.test(info.sessionID) ||
      info.role !== "assistant" ||
      info.error != null ||
      info.finish !== "stop" ||
      typeof time.completed !== "number" ||
      !Number.isSafeInteger(time.completed) ||
      time.completed <= 0 ||
      !Array.isArray(payload.parts)
    )
      throw nativeOpenCodeFailure("incomplete");
    let text = "";
    for (const raw of payload.parts) {
      const part = record(raw);
      if (part.sessionID !== info.sessionID || part.messageID !== info.id)
        throw nativeOpenCodeFailure("protocol_invalid");
      if (part.type === "text") {
        if (typeof part.text !== "string") throw nativeOpenCodeFailure("protocol_invalid");
        text += part.text;
      } else if (part.type === "tool") {
        if (record(part.state).status !== "completed") throw nativeOpenCodeFailure("incomplete");
      } else if (!["step-start", "step-finish", "reasoning", "patch"].includes(String(part.type)))
        throw nativeOpenCodeFailure("protocol_invalid");
    }
    return { kind: "result", sessionId: info.sessionID, text };
  }
  throw nativeOpenCodeFailure("protocol_invalid");
}
