import { existsSync } from "node:fs";
import { getDb } from "@aif/shared/server";
import { withTaskDeviceExecution } from "@aif/data";
import { startTaskDeviceProcess } from "../../services/deviceProcessSupervisor.js";
const [database, taskId, projectRoot, cwd, marker] = process.argv.slice(2);
getDb(database);
await withTaskDeviceExecution({ taskId, projectRoot }, async () => {
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
