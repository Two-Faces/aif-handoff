import { openSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { launchSupervisedProcess } from "../../supervision/processSupervisor.js";

const [journal, marker, state] = process.argv.slice(2);
await launchSupervisedProcess({
  executable: process.execPath,
  args: [
    "-e",
    `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`,
  ],
  cwd: process.cwd(),
  onIdentity: async () => undefined,
  onPrepared: async (identity) => {
    const fd = openSync(journal, "wx");
    try {
      writeFileSync(fd, JSON.stringify(identity));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (state === "prepared") await new Promise(() => undefined);
  },
});
