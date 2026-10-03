import type { Server } from "node:http";
import { randomInt } from "node:crypto";

export async function listenOnHighLoopbackPort(target: Server): Promise<number> {
  // Some hosts assign port 0 from 1024 upwards, including fetch's forbidden
  // ports. Bind directly in the high ephemeral range; no release/rebind race.
  // Windows also reserves port ranges that reject bind with EACCES.
  let listening = false;
  for (let attempt = 0; attempt < 32 && !listening; attempt++) {
    listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        target.off("listening", onListening);
        if (
          error.code === "EADDRINUSE" ||
          (process.platform === "win32" && error.code === "EACCES")
        )
          resolve(false);
        else reject(error);
      };
      const onListening = () => {
        target.off("error", onError);
        resolve(true);
      };
      target.once("error", onError);
      target.once("listening", onListening);
      target.listen(randomInt(49152, 65536), "127.0.0.1");
    });
  }
  if (!listening) throw new Error("No high loopback fixture port available");
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("fixture address");
  return address.port;
}
