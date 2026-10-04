import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Outside the DB backup, so a database copied to another host fails closed. */
export function readDeviceInstallationId(directory = join(homedir(), ".aif-handoff")): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "installation-id");
  try {
    writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  return z.uuid().parse(readFileSync(path, "utf8").trim());
}
