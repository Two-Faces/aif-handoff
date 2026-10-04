import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as childProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPasswordFilePermissions } from "./fixtures/passwordFilePermissions.js";
import type { Participant } from "@aif/shared";
import {
  bootstrapFirstParticipantAdmin,
  parseBootstrapArguments,
  readProtectedPasswordFile,
  type BootstrapDependencies,
} from "../scripts/bootstrapParticipantAdmin.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));

const existingAdmin: Participant = {
  id: "admin-id",
  username: "admin",
  displayName: "Admin",
  role: "admin",
  active: true,
  deactivatedAt: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
};
const directories: string[] = [];
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "aif-bootstrap-"));
  directories.push(directory);
  return { directory, passwordFile: join(directory, "пароль [safe] '$.txt") };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createDependencies(
  overrides: Partial<BootstrapDependencies> = {},
): BootstrapDependencies & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    countParticipants: vi.fn(() => 0),
    findParticipantByUsername: vi.fn(() => null),
    createParticipant: vi.fn(async () => ({
      ok: true as const,
      participant: existingAdmin,
    })),
    readPasswordFile: vi.fn(() => "protected bootstrap password\n"),
    readPasswordStdin: vi.fn(() => "protected bootstrap password\n"),
    isInteractiveTerminal: vi.fn(() => true),
    promptInteractive: vi.fn(async () => ({
      username: "admin",
      displayName: "Admin",
      password: "protected bootstrap password",
      passwordConfirmation: "protected bootstrap password",
    })),
    writeOutput: (message) => output.push(message),
    writeError: (message) => errors.push(message),
    ...overrides,
    output,
    errors,
  };
}

describe("first participant administrator bootstrap", () => {
  it("selects interactive prompts when no arguments are provided", () => {
    expect(parseBootstrapArguments([])).toEqual({ interactive: true });
  });

  it("rejects password arguments and requires exactly one protected input source", () => {
    expect(() =>
      parseBootstrapArguments([
        "--username",
        "admin",
        "--display-name",
        "Admin",
        "--password=secret-value",
      ]),
    ).toThrow("Password arguments are forbidden");
    expect(() =>
      parseBootstrapArguments([
        "--username",
        "admin",
        "--display-name",
        "Admin",
        "--password-file",
        "/secret",
        "--password-stdin",
      ]),
    ).toThrow("exactly one");
  });

  it("creates the first admin from stdin without emitting the password", async () => {
    const dependencies = createDependencies();
    const password = "protected bootstrap password";
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(0);
    expect(dependencies.createParticipant).toHaveBeenCalledWith({
      username: "admin",
      displayName: "Admin",
      password,
      role: "admin",
    });
    expect(dependencies.output.join("\n")).toContain(existingAdmin.id);
    expect(dependencies.output.join("\n")).not.toContain(password);
    expect(dependencies.errors.join("\n")).not.toContain(password);
  });

  it("creates the first admin from hidden interactive prompts", async () => {
    const dependencies = createDependencies();
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(0);
    expect(dependencies.promptInteractive).toHaveBeenCalledTimes(1);
    expect(dependencies.readPasswordFile).not.toHaveBeenCalled();
    expect(dependencies.readPasswordStdin).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).toHaveBeenCalledWith({
      username: "admin",
      displayName: "Admin",
      password: "protected bootstrap password",
      role: "admin",
    });
  });

  it("flushes pending terminal output before showing interactive prompts", async () => {
    const events: string[] = [];
    const pendingOutput = new Promise<void>((resolve) => {
      setImmediate(() => {
        events.push("warning");
        resolve();
      });
    });
    const dependencies = createDependencies({
      promptInteractive: vi.fn(async () => {
        events.push("prompt");
        return {
          username: "admin",
          displayName: "Admin",
          password: "protected bootstrap password",
          passwordConfirmation: "protected bootstrap password",
        };
      }),
    });

    const bootstrap = bootstrapFirstParticipantAdmin([], dependencies);
    await Promise.all([pendingOutput, bootstrap]);

    expect(events).toEqual(["warning", "prompt"]);
  });

  it("refuses interactive input without a terminal", async () => {
    const dependencies = createDependencies({
      isInteractiveTerminal: vi.fn(() => false),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(2);
    expect(dependencies.countParticipants).not.toHaveBeenCalled();
    expect(dependencies.promptInteractive).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).toContain("requires a terminal");
  });

  it("refuses mismatched interactive passwords without persisting", async () => {
    const dependencies = createDependencies({
      promptInteractive: vi.fn(async () => ({
        username: "admin",
        displayName: "Admin",
        password: "protected bootstrap password",
        passwordConfirmation: "different protected password",
      })),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(2);
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors).toEqual(["Passwords do not match."]);
  });

  it("does not prompt when participant accounts already exist", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
    });
    const code = await bootstrapFirstParticipantAdmin([], dependencies);

    expect(code).toBe(1);
    expect(dependencies.promptInteractive).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
  });

  it("is idempotent for the same active admin without reading a secret", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
      findParticipantByUsername: vi.fn(() => existingAdmin),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-file", "/unused"],
      dependencies,
    );

    expect(code).toBe(0);
    expect(dependencies.readPasswordFile).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
  });

  it("refuses bootstrap when a different account already exists", async () => {
    const dependencies = createDependencies({
      countParticipants: vi.fn(() => 1),
      findParticipantByUsername: vi.fn(() => null),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "another-admin", "--display-name", "Another Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(1);
    expect(dependencies.readPasswordStdin).not.toHaveBeenCalled();
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).toContain("accounts already exist");
  });

  it("rejects short passwords without persisting them", async () => {
    const dependencies = createDependencies({
      readPasswordStdin: vi.fn(() => "too-short\n"),
    });
    const code = await bootstrapFirstParticipantAdmin(
      ["--username", "admin", "--display-name", "Admin", "--password-stdin"],
      dependencies,
    );

    expect(code).toBe(2);
    expect(dependencies.createParticipant).not.toHaveBeenCalled();
    expect(dependencies.errors.join("\n")).not.toContain("too-short");
  });

  it("reads only regular password files with owner-only permissions", () => {
    const { directory, passwordFile } = fixture();
    writeFileSync(passwordFile, "protected bootstrap password\n", { mode: 0o600 });
    setPasswordFilePermissions(passwordFile, null);
    expect(readProtectedPasswordFile(passwordFile)).toBe("protected bootstrap password\n");

    setPasswordFilePermissions(passwordFile, "read");
    expect(() => readProtectedPasswordFile(passwordFile)).toThrow(
      "must not be accessible by group or other users",
    );
    expect(() => readProtectedPasswordFile(directory)).toThrow("must be a regular file");
  });

  it("rejects write access for other users and oversized password files", () => {
    const { passwordFile } = fixture();
    writeFileSync(passwordFile, "private password");
    setPasswordFilePermissions(passwordFile, "write");
    expect(() => readProtectedPasswordFile(passwordFile)).toThrow(
      expect.objectContaining({ code: "password_file_permissions" }),
    );
    setPasswordFilePermissions(passwordFile, null);
    writeFileSync(passwordFile, "x".repeat(65_537));
    expect(() => readProtectedPasswordFile(passwordFile)).toThrow(
      expect.objectContaining({ code: "password_file_too_large" }),
    );
  });

  it.runIf(process.platform === "win32")("rejects inherited broad ACL access", () => {
    const { directory, passwordFile } = fixture();
    setPasswordFilePermissions(directory, "read");
    writeFileSync(passwordFile, "private password");
    expect(() => readProtectedPasswordFile(passwordFile)).toThrow(
      expect.objectContaining({ code: "password_file_permissions" }),
    );
    setPasswordFilePermissions(passwordFile, null);
    expect(readProtectedPasswordFile(passwordFile)).toBe("private password");
  });

  it.runIf(process.platform === "win32")(
    "fails closed if the ACL reader fails, without including its output",
    () => {
      const { passwordFile } = fixture();
      writeFileSync(passwordFile, "private password");
      vi.spyOn(childProcess, "spawnSync").mockReturnValue({
        pid: 0,
        output: [],
        stdout: "PRIVATE OUTPUT",
        stderr: "PRIVATE STDERR",
        signal: null,
        status: 1,
      });
      let error: unknown;
      try {
        readProtectedPasswordFile(passwordFile);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "password_file_unreadable" });
      expect(String(error)).not.toMatch(/PRIVATE/);
    },
  );
});
