import { readFileSync } from "node:fs";
import { executeTaskDeviceIsolatedRuntime } from "../../services/deviceIsolatedRuntime.js";
const [taskId, path] = process.argv.slice(2);
await executeTaskDeviceIsolatedRuntime(taskId, JSON.parse(readFileSync(path, "utf8")));
