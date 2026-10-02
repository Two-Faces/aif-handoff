import { eq } from "drizzle-orm";
import { localDevice } from "@aif/shared";
import { getDb } from "@aif/shared/server";

export class DeviceIdentityError extends Error {
  constructor(
    readonly code: "device_identity_mismatch" | "device_in_use" | "device_not_initialized",
  ) {
    super(code);
    this.name = "DeviceIdentityError";
  }
}

export function getLocalDevice() {
  const row = getDb().select().from(localDevice).where(eq(localDevice.slot, 1)).get();
  if (!row) throw new DeviceIdentityError("device_not_initialized");
  return { deviceId: row.deviceId, incarnation: row.incarnation, name: row.name };
}

export function initializeLocalDevice(installationId: string, name: string) {
  if (!installationId || !name.trim()) throw new DeviceIdentityError("device_not_initialized");
  return getDb().transaction((tx) => {
    const row = tx.select().from(localDevice).where(eq(localDevice.slot, 1)).get();
    if (!row) throw new DeviceIdentityError("device_not_initialized");
    if (row.installationId && row.installationId !== installationId) {
      throw new DeviceIdentityError("device_identity_mismatch");
    }
    tx.update(localDevice)
      .set({ installationId, name: name.trim() })
      .where(eq(localDevice.slot, 1))
      .run();
    return getLocalDevice();
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH")
      return false;
    // Unknown/permission errors do not prove that the owner stopped.
    return true;
  }
}

/** API-node lock; an expired timer never grants ownership. Process exit is required. */
export function acquireLocalDeviceLock(installationId: string, name: string): () => void {
  const token = crypto.randomUUID();
  getDb().transaction((tx) => {
    initializeLocalDevice(installationId, name);
    const row = tx.select().from(localDevice).where(eq(localDevice.slot, 1)).get();
    if (!row) throw new DeviceIdentityError("device_not_initialized");
    if (row.ownerPid !== null && processIsAlive(row.ownerPid)) {
      throw new DeviceIdentityError("device_in_use");
    }
    tx.update(localDevice)
      .set({ ownerPid: process.pid, ownerToken: token })
      .where(eq(localDevice.slot, 1))
      .run();
  });
  return () => {
    getDb()
      .update(localDevice)
      .set({ ownerPid: null, ownerToken: null })
      .where(eq(localDevice.ownerToken, token))
      .run();
  };
}
