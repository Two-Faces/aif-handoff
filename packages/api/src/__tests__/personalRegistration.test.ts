import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDb } from "@aif/shared/server";
import { participants, resetEnvCache } from "@aif/shared";
import { readDeviceInstallationId } from "../services/deviceInstallation.js";

const testDb = { current: createTestDb() };
const roots: string[] = [];
vi.mock("@aif/shared/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aif/shared/server")>()),
  getDb: () => testDb.current,
}));
const data = await import("@aif/data");
const { personalProjectsRouter } = await import("../routes/personal.js");
const app = new Hono().route("/projects", personalProjectsRouter);
const post = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.stubEnv("AIF_PERSONAL_MODE", "false");
  resetEnvCache();
  testDb.current.$client.close();
  testDb.current = createTestDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aif-registration-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
  writeFileSync(join(root, "untracked"), "keep");
  return root;
}

describe("personal registration surfaces", () => {
  it("previews valid and missing checkout entries without registration or context writes", async () => {
    const root = fixture();
    const response = await post("/projects/attach-preview", {
      checkouts: [
        { localRoot: root, executionEnvironment: "native_windows" },
        { localRoot: join(root, "absent"), executionEnvironment: "native_macos" },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      registrationPerformed: false,
      checkouts: [
        { ok: true, head: null },
        { ok: false, code: "invalid_git_checkout" },
      ],
    });
    expect(data.listProjects()).toEqual([]);
    expect(existsSync(join(root, ".ai-factory"))).toBe(false);
    expect(readFileSync(join(root, "untracked"), "utf8")).toBe("keep");
  });

  it("requires explicit mapping to a project and writes a portable manifest only separately", async () => {
    const root = fixture();
    const project = data.createProject({ name: "Shared board", rootPath: "", personalMode: true })!;
    const body = { localRoot: root, executionEnvironment: "native_windows" };
    expect((await post(`/projects/${project.id}/checkouts`, body)).status).toBe(400);
    const attached = await post(`/projects/${project.id}/checkouts`, {
      ...body,
      confirmProjectIdentity: true,
    });
    expect(attached.status).toBe(201);
    const binding = data.listProjectCheckouts(project.id)[0]!;
    expect(existsSync(join(root, ".ai-factory"))).toBe(false);
    expect(data.findProjectById(project.id)?.rootPath).toBe("");
    const listed = await app.request(`/projects/${project.id}/checkouts`);
    expect(await listed.json()).toMatchObject({
      device: { deviceId: binding.deviceId },
      checkouts: [{ id: binding.id }],
    });
    expect(
      (await post(`/projects/${project.id}/manifest`, { checkoutId: binding.id })).status,
    ).toBe(400);
    const manifest = await post(`/projects/${project.id}/manifest`, {
      checkoutId: binding.id,
      confirmWrite: true,
    });
    expect(manifest.status).toBe(201);
    expect(
      JSON.parse(readFileSync(join(root, ".ai-factory", "handoff-project.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, kind: "aif-handoff-project", projectId: project.id });
    const repeated = await post(`/projects/${project.id}/manifest`, {
      checkoutId: binding.id,
      confirmWrite: true,
    });
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({ code: "manifest_exists" });
  });

  it("binds an unresolved logical identity only after confirmation", async () => {
    const project = data.createProject({ name: "Board", rootPath: "", personalMode: true })!;
    const id = crypto.randomUUID();
    const participantId = crypto.randomUUID();
    testDb.current
      .insert(participants)
      .values({
        id: participantId,
        username: "local",
        normalizedUsername: "local",
        displayName: "Owner",
        passwordHash: "secret",
      })
      .run();
    data.recordLogicalParticipant({ projectId: project.id, id, displayName: "Owner" });
    const body = { logicalParticipantId: id, participantId };
    expect((await post(`/projects/${project.id}/identities/bind`, body)).status).toBe(400);
    expect(data.resolveLocalParticipant(project.id, id)).toBeNull();
    expect(
      (await post(`/projects/${project.id}/identities/bind`, { ...body, confirmIdentity: true }))
        .status,
    ).toBe(200);
    const listed = await app.request(`/projects/${project.id}/identities`);
    const payload = await listed.text();
    expect(JSON.parse(payload)).toEqual([
      { projectId: project.id, id, displayName: "Owner", localParticipantId: participantId },
    ]);
    expect(payload).not.toContain("secret");
    expect(
      (
        await post(`/projects/${project.id}/identities/bind`, {
          ...body,
          logicalParticipantId: crypto.randomUUID(),
          confirmIdentity: true,
        })
      ).status,
    ).toBe(409);
  });

  it("keeps an installation marker stable and refuses corrupted metadata", () => {
    const root = fixture();
    const metadata = join(root, "local-state");
    const first = readDeviceInstallationId(metadata);
    expect(readDeviceInstallationId(metadata)).toBe(first);
    writeFileSync(join(metadata, "installation-id"), "corrupted");
    expect(() => readDeviceInstallationId(metadata)).toThrow();
    expect(readFileSync(join(metadata, "installation-id"), "utf8")).toBe("corrupted");
  });
});
