import { RuntimeExecutionError } from "../../errors.js";

type Frame =
  | { kind: "init"; sessionId: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_done"; name: string; input: Record<string, unknown> }
  | { kind: "subagent"; name: string; id: string }
  | {
      kind: "result";
      sessionId: string;
      subtype: string;
      isError: boolean;
      text: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
      cost: number;
    }
  | { kind: "complete" };

export function nativeClaudeFailure(code: string, cause?: unknown) {
  return new RuntimeExecutionError("Native Claude SDK attempt failed", cause, "transport", {
    adapterCode: "native_claude_" + code,
  });
}
function invalid(): never {
  throw nativeClaudeFailure("protocol_invalid");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value)) return invalid();
  return value;
}
function number(value: unknown, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    return invalid();
  return value;
}
/** Project only known fields; raw SDK errors and arbitrary control-like frames
 * cannot become host callbacks, stop evidence or authority changes. */
export function parseNativeClaudeFrame(line: string): Frame {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return invalid();
  }
  const frame = record(raw);
  switch (frame.kind) {
    case "init":
      return { kind: frame.kind, sessionId: text(frame.sessionId, true) };
    case "text":
      return { kind: frame.kind, text: text(frame.text) };
    case "tool_use":
      return {
        kind: frame.kind,
        id: text(frame.id, true),
        name: text(frame.name, true),
        input: record(frame.input),
      };
    case "tool_done":
      return { kind: frame.kind, name: text(frame.name, true), input: record(frame.input) };
    case "subagent":
      return { kind: frame.kind, name: text(frame.name, true), id: text(frame.id, true) };
    case "complete":
      return { kind: frame.kind };
    case "error":
      if (frame.code === "worker_failed" || frame.code === "version_unsupported")
        throw nativeClaudeFailure(frame.code);
      return invalid();
    case "result": {
      if (typeof frame.isError !== "boolean") return invalid();
      const usage = record(frame.usage);
      return {
        kind: frame.kind,
        sessionId: text(frame.sessionId, true),
        subtype: text(frame.subtype, true),
        isError: frame.isError,
        text: text(frame.text),
        cost: number(frame.cost),
        usage: {
          input_tokens: number(usage.input_tokens, true),
          output_tokens: number(usage.output_tokens, true),
          cache_read_input_tokens: number(usage.cache_read_input_tokens ?? 0, true),
          cache_creation_input_tokens: number(usage.cache_creation_input_tokens ?? 0, true),
        },
      };
    }
    default:
      return invalid();
  }
}
