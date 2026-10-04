import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  RuntimeEvent,
  RuntimeRunInput,
  RuntimeRunResult,
  RuntimeSessionForkInput,
  RuntimeUsage,
} from "../../types.js";
import { runNativeBatch } from "../../supervision/nativeBatch.js";
import {
  nativeProcessEnvironment,
  resolveNativeExecutable,
} from "../../supervision/nativeProcessScope.js";
import { buildClaudeQueryOptions, parseExecutionOptions } from "./options.js";
import { CLAUDE_MIN_VERSION, isVersionBelowMin, readBundledClaudeVersion } from "./version.js";
import { classifyClaudeResultSubtype } from "./errors.js";
import { summarizeToolInput } from "./hooks.js";
import { buildToolUseEvents } from "../../toolEvents.js";
import { parseClaudeAskUserQuestion } from "./questions.js";
import { NATIVE_CLAUDE_WORKER } from "./nativeWorker.js";
import { nativeClaudeFailure, parseNativeClaudeFrame } from "./nativeProtocol.js";

export function isNativeClaudeTransport(transport: RuntimeRunInput["transport"]) {
  return (
    transport === undefined || transport === "sdk" || transport === "api" || transport === "cli"
  );
}

/** Deliberately bounded admission for the internal fresh Claude paths. Ordinary
 * project hooks/settings, session reuse and external MCP services remain open. */
export function assertNativeClaudeInput(input: RuntimeRunInput) {
  const execution = input.execution;
  const allowedOptions = new Set(["apiKey", "apiKeyEnvVar", "baseUrl", "claudeCliPath", "effort"]);
  const unsupported =
    !isNativeClaudeTransport(input.transport) ||
    input.sessionId ||
    input.resume ||
    (input as Partial<RuntimeSessionForkInput>).sourceSessionId ||
    input.headers !== undefined ||
    execution?.hooks !== undefined ||
    execution?.environment !== undefined ||
    execution?.outputSchema !== undefined ||
    execution?.agentDefinitionName !== undefined ||
    execution?.bypassPermissions ||
    Object.keys(input.options ?? {}).some((key) => !allowedOptions.has(key));
  if (unsupported) throw nativeClaudeFailure("input_invalid");
}

export async function runNativeClaude(
  input: RuntimeRunInput,
  executableOverride?: string,
): Promise<RuntimeRunResult> {
  assertNativeClaudeInput(input);
  const transport = input.transport ?? "sdk";
  const isCli = transport === "cli";
  const execution = parseExecutionOptions(input);
  // Host callbacks stay in their fenced async context, never serialized to SDK.
  const options = buildClaudeQueryOptions(input, {
    ...execution,
    abortController: undefined,
    stderr: undefined,
    onToolUse: undefined,
    onSubagentStart: undefined,
    settingSources: [],
  });
  // This internal increment cannot admit config-driven external services.
  options.strictMcpConfig = true;
  options.mcpServers = {};
  options.persistSession = false;
  options.includePartialMessages = true;
  const environment = nativeProcessEnvironment(options.env as Record<string, string>);
  for (const key of Object.keys(environment))
    if (["NODE_OPTIONS", "NODE_PATH", "DEBUG_CLAUDE_AGENT_SDK"].includes(key.toUpperCase()))
      delete environment[key];
  options.env = environment;
  const override =
    input.options?.claudeCliPath !== undefined
      ? input.options.claudeCliPath
      : isCli
        ? (process.env.CLAUDE_CLI_PATH ?? executableOverride ?? "claude")
        : executableOverride;
  if (override !== undefined) {
    if (typeof override !== "string" || !override) throw nativeClaudeFailure("input_invalid");
    if (/\.(?:mjs|js)$/.test(override)) {
      if (!isAbsolute(override) || !statSync(override).isFile())
        throw nativeClaudeFailure("input_invalid");
      options.pathToClaudeCodeExecutable = realpathSync(override);
    } else options.pathToClaudeCodeExecutable = resolveNativeExecutable(override, environment);
  } else {
    const version = readBundledClaudeVersion();
    if (!version || isVersionBelowMin(version)) throw nativeClaudeFailure("version_unsupported");
  }
  const stdin = JSON.stringify({
    version: 1,
    transport,
    minimumVersion: CLAUDE_MIN_VERSION,
    prompt: input.prompt,
    options,
  });
  if (Buffer.byteLength(stdin) > 1024 * 1024) throw nativeClaudeFailure("input_limit");
  const events: RuntimeEvent[] = [];
  let outputText = "",
    sessionId: string | null = null,
    resultSeen = false,
    complete = false;
  let usage: RuntimeUsage | null = null;
  const emit = (event: RuntimeEvent) => {
    events.push(event);
    execution.onEvent?.(event);
  };
  return runNativeBatch({
    input,
    stdin,
    runTimeoutMs: execution.runTimeoutMs ?? (isCli ? 300_000 : undefined),
    command: {
      executable: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        NATIVE_CLAUDE_WORKER,
        ...(isCli ? [] : [import.meta.resolve("@anthropic-ai/claude-agent-sdk")]),
      ],
      environment: nativeProcessEnvironment({}),
    },
    failure: nativeClaudeFailure,
    line: (line) => {
      if (complete) throw nativeClaudeFailure("protocol_invalid");
      const frame = parseNativeClaudeFrame(line);
      if (isCli && (frame.kind === "tool_done" || frame.kind === "subagent"))
        throw nativeClaudeFailure("protocol_invalid");
      if (frame.kind === "complete") {
        if (!resultSeen) throw nativeClaudeFailure("incomplete");
        complete = true;
        return;
      }
      if (resultSeen) throw nativeClaudeFailure("protocol_invalid");
      const timestamp = new Date().toISOString();
      if (frame.kind === "init") {
        if (sessionId) throw nativeClaudeFailure("protocol_invalid");
        sessionId = frame.sessionId;
        emit({ type: "system:init", timestamp, level: "info", data: { sessionId } });
        return;
      }
      if (!sessionId) throw nativeClaudeFailure("protocol_invalid");
      switch (frame.kind) {
        case "text":
          outputText += frame.text;
          emit({
            type: "stream:text",
            timestamp,
            level: "debug",
            message: frame.text,
            data: { text: frame.text },
          });
          break;
        case "tool_use":
          for (const event of buildToolUseEvents({
            toolName: frame.name,
            toolUseId: frame.id,
            input: frame.input,
            timestamp,
            questionPayload: parseClaudeAskUserQuestion(frame.name, frame.id, frame.input),
          }))
            emit(event);
          // CLI reports invocation in its assistant event; SDK/API use the
          // real PostToolUse callback. Neither event is native stop evidence.
          if (isCli) execution.onToolUse?.(frame.name, summarizeToolInput(frame.name, frame.input));
          break;
        case "tool_done":
          execution.onToolUse?.(frame.name, summarizeToolInput(frame.name, frame.input));
          break;
        case "subagent":
          execution.onSubagentStart?.(frame.name, frame.id);
          break;
        case "result": {
          if (frame.sessionId !== sessionId) throw nativeClaudeFailure("protocol_invalid");
          if (frame.subtype !== "success") throw classifyClaudeResultSubtype(frame.subtype);
          if (frame.isError) throw nativeClaudeFailure("result_failed");
          resultSeen = true;
          if (!outputText) outputText = frame.text;
          const inputTokens =
            frame.usage.input_tokens +
            (isCli
              ? frame.usage.cache_read_input_tokens + frame.usage.cache_creation_input_tokens
              : 0);
          usage = {
            inputTokens,
            outputTokens: frame.usage.output_tokens,
            totalTokens: inputTokens + frame.usage.output_tokens,
            costUsd: frame.cost,
          };
          emit({ type: "result:success", timestamp, level: "info" });
        }
      }
    },
    complete: () => {
      if (!complete) throw nativeClaudeFailure("incomplete");
      return { outputText, sessionId, usage, events };
    },
  });
}
