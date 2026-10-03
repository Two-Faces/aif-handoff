import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@aif/shared/server";
import { withTaskDeviceExecution, findTaskById } from "@aif/data";
import { UsageSource } from "@aif/runtime";
import {
  startTaskDeviceProcess,
  runTaskDeviceSdk,
  runTaskDeviceClaudeSdk,
  runTaskDeviceClaudeCli,
  runTaskDeviceClaudeApi,
  runTaskDeviceHttp,
  runTaskDeviceOpenCode,
} from "../../services/deviceProcessSupervisor.js";
const [database, taskId, projectRoot, cwd, marker, mode] = process.argv.slice(2);
getDb(database);
await withTaskDeviceExecution({ taskId, projectRoot }, async () => {
  if (mode === "opencode") {
    await runTaskDeviceOpenCode(taskId, {
      runtimeId: "opencode",
      transport: "api",
      cwd,
      model: "fixture",
      prompt: "fixture",
      options: { opencodeCliPath: marker, modelBaseUrl: "http://127.0.0.1:1234/v1" },
      usageContext: {
        source: UsageSource.TEST,
        taskId,
        projectId: findTaskById(taskId)!.projectId,
      },
      execution: {
        runTimeoutMs: 10000,
        onEvent: (event) => {
          if (event.type === "system:init") process.exit(86);
        },
      },
    });
    throw new Error("OpenCode crash fixture unexpectedly completed");
  }
  if (mode === "http-codex" || mode === "http-openrouter") {
    await runTaskDeviceHttp(taskId, {
      runtimeId: mode === "http-codex" ? "codex" : "openrouter",
      transport: "api",
      model: "fixture-model",
      prompt: "fixture",
      cwd,
      options: { baseUrl: marker, apiKey: "fixture-secret" },
      usageContext: {
        source: UsageSource.TEST,
        taskId,
        projectId: findTaskById(taskId)!.projectId,
      },
      execution: {
        runTimeoutMs: 10000,
        onEvent: (event) => {
          if (event.type === "stream:text") process.exit(86);
        },
      },
    });
    throw new Error("HTTP crash fixture unexpectedly completed");
  }
  const claude = mode === "claude" || mode === "claude-cli" || mode === "claude-api";
  if (mode === "sdk" || claude) {
    const run =
      mode === "claude-cli"
        ? runTaskDeviceClaudeCli
        : mode === "claude-api"
          ? runTaskDeviceClaudeApi
          : mode === "claude"
            ? runTaskDeviceClaudeSdk
            : runTaskDeviceSdk;
    await run(taskId, {
      runtimeId: claude ? "claude" : "codex",
      transport: mode === "claude-cli" ? "cli" : mode === "claude-api" ? "api" : "sdk",
      prompt: "fixture",
      cwd,
      options: claude
        ? { claudeCliPath: join(cwd, "claude-fixture.mjs") }
        : { codexCliPath: process.execPath },
      usageContext: {
        source: UsageSource.TEST,
        taskId,
        projectId: findTaskById(taskId)!.projectId,
      },
      execution: {
        runTimeoutMs: 10000,
        onEvent: (event) => {
          if (event.type === "stream:text" && existsSync(marker)) process.exit(86);
        },
      },
    });
    throw new Error("SDK crash fixture unexpectedly completed");
  }
  await startTaskDeviceProcess(taskId, {
    executable: process.execPath,
    args: [
      "-e",
      `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`,
    ],
    cwd,
  });
  while (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 10));
  process.exit(86);
});
