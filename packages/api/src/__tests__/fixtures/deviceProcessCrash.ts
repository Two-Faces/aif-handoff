import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@aif/shared/server";
import { withTaskDeviceExecution, findTaskById } from "@aif/data";
import { UsageSource } from "@aif/runtime";
import {
  startTaskDeviceProcess,
  runTaskDeviceSdk,
  runTaskDeviceClaudeSdk,
} from "../../services/deviceProcessSupervisor.js";
const [database, taskId, projectRoot, cwd, marker, mode] = process.argv.slice(2);
getDb(database);
await withTaskDeviceExecution({ taskId, projectRoot }, async () => {
  if (mode === "sdk" || mode === "claude") {
    const run = mode === "claude" ? runTaskDeviceClaudeSdk : runTaskDeviceSdk;
    await run(taskId, {
      runtimeId: mode === "claude" ? "claude" : "codex",
      transport: "sdk",
      prompt: "fixture",
      cwd,
      options:
        mode === "claude"
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
