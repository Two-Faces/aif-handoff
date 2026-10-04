import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import { RuntimeExecutionError } from "../../errors.js";

export function nativeSdkFailure(code: string, cause?: unknown): RuntimeExecutionError {
  return new RuntimeExecutionError("Native Codex SDK failed: " + code, cause, "stream", {
    adapterCode: "native_sdk_" + code,
  });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw nativeSdkFailure("protocol_invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw nativeSdkFailure("protocol_invalid");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw nativeSdkFailure("protocol_invalid");
  return value;
}
function exitCode(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw nativeSdkFailure("protocol_invalid");
  return value;
}
function status<T extends string>(value: unknown, allowed: readonly T[]): T {
  for (const candidate of allowed) if (candidate === value) return candidate;
  throw nativeSdkFailure("protocol_invalid");
}
function item(value: unknown): ThreadItem {
  const data = record(value),
    id = text(data.id);
  switch (data.type) {
    case "agent_message":
    case "reasoning":
      return { id, type: data.type, text: text(data.text) };
    case "command_execution":
      return {
        id,
        type: data.type,
        command: text(data.command),
        aggregated_output: text(data.aggregated_output),
        status: status(data.status, ["in_progress", "completed", "failed"]),
        ...(data.exit_code === undefined ? {} : { exit_code: exitCode(data.exit_code) }),
      };
    case "file_change": {
      if (!Array.isArray(data.changes)) throw nativeSdkFailure("protocol_invalid");
      return {
        id,
        type: data.type,
        status: status(data.status, ["completed", "failed"]),
        changes: data.changes.map((value) => {
          const change = record(value);
          return {
            path: text(change.path),
            kind: status(change.kind, ["add", "delete", "update"]),
          };
        }),
      };
    }
    case "mcp_tool_call":
      return {
        id,
        type: data.type,
        server: text(data.server),
        tool: text(data.tool),
        arguments: data.arguments,
        status: status(data.status, ["in_progress", "completed", "failed"]),
      };
    case "web_search":
      return { id, type: data.type, query: text(data.query) };
    case "error":
      return { id, type: data.type, message: text(data.message) };
    case "todo_list": {
      if (!Array.isArray(data.items)) throw nativeSdkFailure("protocol_invalid");
      return {
        id,
        type: data.type,
        items: data.items.map((value) => {
          const todo = record(value);
          if (typeof todo.completed !== "boolean") throw nativeSdkFailure("protocol_invalid");
          return { text: text(todo.text), completed: todo.completed };
        }),
      };
    }
    default:
      throw nativeSdkFailure("protocol_invalid");
  }
}
export type NativeSdkFrame =
  | { kind: "event"; event: ThreadEvent }
  | { kind: "complete"; sessionId: string };

/** Validate and project only SDK fields consumed by host callbacks. Worker JSON
 * never carries execution authority or native stop evidence. */
export function parseNativeSdkFrame(line: string): NativeSdkFrame {
  let frame: Record<string, unknown>;
  try {
    frame = record(JSON.parse(line));
  } catch {
    throw nativeSdkFailure("protocol_invalid");
  }
  if (frame.kind === "error" && frame.code === "sdk_worker_failed")
    throw nativeSdkFailure("worker_failed");
  if (frame.kind === "complete") return { kind: "complete", sessionId: text(frame.sessionId) };
  if (frame.kind !== "event") throw nativeSdkFailure("protocol_invalid");
  const event = record(frame.event);
  switch (event.type) {
    case "thread.started":
      return { kind: "event", event: { type: event.type, thread_id: text(event.thread_id) } };
    case "turn.started":
      return { kind: "event", event: { type: event.type } };
    case "turn.completed": {
      const raw = record(event.usage);
      const usage: Usage = {
        input_tokens: count(raw.input_tokens),
        output_tokens: count(raw.output_tokens),
        cached_input_tokens: count(raw.cached_input_tokens),
        cache_write_input_tokens: count(raw.cache_write_input_tokens ?? 0),
        reasoning_output_tokens: count(raw.reasoning_output_tokens ?? 0),
      };
      return { kind: "event", event: { type: event.type, usage } };
    }
    case "turn.failed":
    case "error":
      throw nativeSdkFailure("turn_failed");
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { kind: "event", event: { type: event.type, item: item(event.item) } };
    default:
      throw nativeSdkFailure("protocol_invalid");
  }
}
