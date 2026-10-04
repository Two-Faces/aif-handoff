import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareTaskCheckout, type TaskCheckoutInput } from "../taskCheckout.js";
import {
  beginTaskChangeScope,
  commitTaskChanges,
  restoreTaskChangeScope,
  serializeTaskChangeScope,
} from "../taskCommit.js";
import {
  continuationNotesSchema,
  isPortableContextPath,
  type CodeSnapshotPackage,
} from "../handoff/contracts.js";
import {
  captureCodeSnapshotPackage,
  codeSnapshotRef,
  contextBlobDigest,
  installContextSnapshot,
  pinCodeSnapshot,
  snapshotDigest,
  verifyCodeSnapshotPackage,
} from "../handoff/contextSnapshot.js";

const TIMEOUT = 30_000;
const notes = continuationNotesSchema.parse({
  goal: "Continue the task",
  nextStep: "Run the native checks",
});
function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root: string, path: string, text: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
let directory: string;
let checkout: TaskCheckoutInput;
beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-context-")));
  const source = join(directory, "source");
  mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Context Test");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "core.autocrlf", "false");
  git(source, "config", "commit.gpgsign", "false");
  write(source, "task.txt", "base\n");
  write(source, "AGENTS.md", "# Committed instructions\n");
  write(source, ".gitignore", ".ai-factory/\n.codex/\n.env\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "base");
  checkout = {
    projectRoot: source,
    worktreePath: join(directory, "task"),
    projectId: "project",
    taskId: "task",
    snapshotCommit: git(source, "rev-parse", "HEAD"),
  };
  prepareTaskCheckout(checkout);
});
afterEach(() => {
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});
function capture(portablePaths: string[] = [], commitSha = checkout.snapshotCommit) {
  return captureCodeSnapshotPackage({
    checkout,
    commitSha,
    notes,
    planText: "# Plan",
    portablePaths,
    sourceDeviceId: "74870384-2979-43dc-bb16-299c7f7b3152",
  });
}
function rebind(pack: CodeSnapshotPackage) {
  pack.descriptor.contextDigest = snapshotDigest(pack.context);
  pack.id = snapshotDigest(pack.descriptor);
  return pack;
}
function nextCheckout(pack: CodeSnapshotPackage) {
  const next = {
    ...checkout,
    worktreePath: join(directory, "next"),
    snapshotCommit: pack.descriptor.commitSha,
  };
  prepareTaskCheckout(next);
  return next;
}
function blobText(pack: CodeSnapshotPackage, path: string) {
  const file = pack.context.files.find((entry) => entry.path === path)!;
  return Buffer.from(
    pack.blobs.find((blob) => blob.digest === file.digest)!.base64,
    "base64",
  ).toString();
}

describe("immutable code/context snapshots", () => {
  it(
    "takes tracked context from the exact commit and includes only explicitly selected portable files",
    () => {
      write(checkout.worktreePath, "AGENTS.md", "Uncommitted local instructions\n");
      write(checkout.worktreePath, ".ai-factory/DESCRIPTION.md", "AIF 2.19 context\n");
      write(checkout.worktreePath, ".ai-factory/RULES.md", "Not selected\n");
      write(checkout.worktreePath, ".codex/config.toml", "local machine config\n");
      write(checkout.worktreePath, ".env", "LOCAL_SECRET=never-copy\n");
      const pack = capture([".ai-factory/DESCRIPTION.md", "AGENTS.md"]);
      expect(pack.context.files.map((file) => file.path)).toEqual([
        ".ai-factory/DESCRIPTION.md",
        "AGENTS.md",
      ]);
      expect(blobText(pack, "AGENTS.md")).toBe("# Committed instructions\n");
      expect(blobText(pack, ".ai-factory/DESCRIPTION.md")).toBe("AIF 2.19 context\n");
      expect(JSON.stringify(pack)).not.toContain(directory);
      expect(verifyCodeSnapshotPackage(pack)).toEqual(pack);
      expect(capture([".ai-factory/DESCRIPTION.md", "AGENTS.md"])).toEqual(pack);
      write(checkout.worktreePath, ".ai-factory/DESCRIPTION.md", "Updated context\n");
      const changed = capture([".ai-factory/DESCRIPTION.md"]);
      expect(changed.id).not.toBe(pack.id);
      expect(changed.descriptor.commitSha).toBe(pack.descriptor.commitSha);
    },
    TIMEOUT,
  );

  it(
    "rejects machine configuration, traversal, reserved names, hidden secrets and nonportable paths",
    () => {
      const paths = [
        ".env",
        ".codex/config.toml",
        ".codex/auth.json",
        ".claude/settings.local.json",
        "../AGENTS.md",
        "/AGENTS.md",
        "C:/AGENTS.md",
        "docs/agent-context/CON.md",
        "docs/agent-context/foo.md ",
        "docs/agent-context/.git/x.md",
        "docs/agent-context/secret.txt",
        ".agents/skills/test/auth.json",
        ".agents/skills/test/sessions/a.md",
        ".ai-factory/x.sqlite",
        "docs/agent-context/e\u0301.md",
        "docs\\agent-context\\x.md",
        "docs/agent-context/a\u0000.md",
      ];
      for (const path of paths) {
        expect(isPortableContextPath(path), path).toBe(false);
        expect(() => capture([path])).toThrow();
      }
      for (const path of [
        "AGENTS.md",
        "CLAUDE.md",
        ".agents/skills/test/SKILL.md",
        ".agents/skills/test/scripts/check.py",
        ".codex/agents/reviewer.toml",
        "docs/agent-context/check.json",
      ])
        expect(isPortableContextPath(path), path).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "validates all blob bytes, manifest bindings, plan hash and complete referenced artifacts",
    () => {
      const pack = capture();
      const mutations: ((value: CodeSnapshotPackage) => void)[] = [
        (value) => {
          value.id = "a".repeat(64);
        },
        (value) => {
          value.context.plan.text = "tampered";
          rebind(value);
        },
        (value) => {
          value.context.taskId = "other";
          rebind(value);
        },
        (value) => {
          value.descriptor.objectFormat = "sha256";
          value.id = snapshotDigest(value.descriptor);
        },
        (value) => {
          value.blobs[0].base64 = Buffer.from("wrong").toString("base64");
        },
        (value) => {
          value.blobs[0].base64 += "\n";
        },
        (value) => {
          value.blobs.push(value.blobs[0]);
        },
        (value) => {
          value.context.files[0].size++;
          rebind(value);
        },
        (value) => {
          value.context.files[0].gitBlob = null;
          rebind(value);
        },
        (value) => {
          value.context.notes.checks.push({
            command: "npm test",
            outcome: "passed",
            summary: "fixture",
            artifactPaths: ["docs/agent-context/missing.md"],
          });
          rebind(value);
        },
        (value) => {
          const bytes = Buffer.from("extra");
          value.blobs.push({ digest: contextBlobDigest(bytes), base64: bytes.toString("base64") });
        },
      ];
      for (const mutate of mutations) {
        const changed = structuredClone(pack);
        mutate(changed);
        expect(() => verifyCodeSnapshotPackage(changed)).toThrow();
      }
      expect(() => verifyCodeSnapshotPackage({ ...pack, blobs: [] })).toThrow(
        expect.objectContaining({ code: "missing_blob" }),
      );
      expect(() => verifyCodeSnapshotPackage({ ...pack, localRoot: directory })).toThrow();
    },
    TIMEOUT,
  );

  it(
    "detects case and file/directory collisions before materialization",
    () => {
      write(checkout.worktreePath, ".ai-factory/README.md", "context\n");
      const pack = capture([".ai-factory/README.md"]);
      for (const path of [".ai-factory/readme.md", ".ai-factory/README.md/child.md"]) {
        const changed = structuredClone(pack);
        changed.context.files.push({ ...changed.context.files[0], path });
        expect(() => verifyCodeSnapshotPackage(rebind(changed))).toThrow();
      }
    },
    TIMEOUT,
  );

  it(
    "accepts portable role definitions and rejects local settings and permission escalation",
    () => {
      const path = ".codex/agents/reviewer.toml";
      write(
        checkout.worktreePath,
        path,
        '# Portable role\nname = "reviewer"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nReview the patch.\n"""\n',
      );
      const pack = capture([path]);
      expect(blobText(pack, path)).toContain("Review the patch.");
      for (const text of [
        '[mcp_servers.local]\ncommand = "sh"',
        'sandbox_mode = "danger-full-access"',
        "model = 17",
        'name = "a"\nname = "b"',
        'developer_instructions = """unterminated',
        'model = """unsupported"""',
        'description = """ok""" arbitrary',
        'description = """\nend\n""" arbitrary',
      ]) {
        write(checkout.worktreePath, path, text);
        expect(() => capture([path]), text).toThrow(
          expect.objectContaining({ code: "invalid_context_path" }),
        );
      }
    },
    TIMEOUT,
  );

  it(
    "installs context without overwriting existing edits and repeats identical installs",
    () => {
      write(checkout.worktreePath, ".ai-factory/RULES.md", "keep exact\n");
      const pack = capture([".ai-factory/RULES.md"]);
      const next = nextCheckout(pack);
      installContextSnapshot({ checkout: next, package: pack });
      installContextSnapshot({ checkout: next, package: pack });
      expect(readFileSync(join(next.worktreePath, ".ai-factory/RULES.md"), "utf8")).toBe(
        "keep exact\n",
      );
      write(next.worktreePath, ".ai-factory/RULES.md", "User edit\n");
      expect(() => installContextSnapshot({ checkout: next, package: pack })).toThrow(
        expect.objectContaining({ code: "context_collision" }),
      );
      expect(readFileSync(join(next.worktreePath, ".ai-factory/RULES.md"), "utf8")).toBe(
        "User edit\n",
      );
      expect(() =>
        installContextSnapshot({ checkout: { ...next, taskId: "another" }, package: pack }),
      ).toThrow();
    },
    TIMEOUT,
  );

  it(
    "preflights tracked edits and target attributes before writing any portable file or invoking a filter",
    () => {
      write(checkout.worktreePath, ".ai-factory/RULES.md", "portable\n");
      const pack = capture([".ai-factory/RULES.md"]);
      const next = nextCheckout(pack);
      write(next.worktreePath, "AGENTS.md", "User edit\n");
      expect(() => installContextSnapshot({ checkout: next, package: pack })).toThrow(
        expect.objectContaining({ code: "context_collision" }),
      );
      expect(existsSync(join(next.worktreePath, ".ai-factory/RULES.md"))).toBe(false);
      write(next.worktreePath, "AGENTS.md", "# Committed instructions\n");
      git(
        checkout.projectRoot,
        "config",
        "filter.context.clean",
        "echo executed > filter-executed.txt",
      );
      write(next.worktreePath, ".gitattributes", "AGENTS.md filter=context\n");
      expect(() => installContextSnapshot({ checkout: next, package: pack })).toThrow();
      expect(existsSync(join(next.worktreePath, "filter-executed.txt"))).toBe(false);
      expect(existsSync(join(next.worktreePath, ".ai-factory/RULES.md"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "rejects junction context sources and oversize context files",
    () => {
      const outside = join(directory, "outside");
      mkdirSync(outside);
      write(outside, "RULES.md", "outside\n");
      symlinkSync(
        outside,
        join(checkout.worktreePath, ".ai-factory"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() => capture([".ai-factory/RULES.md"])).toThrow(
        expect.objectContaining({ code: "invalid_context_path" }),
      );
      write(checkout.worktreePath, ".codex/agents/large.md", Buffer.alloc(1_048_577));
      expect(() => capture([".codex/agents/large.md"])).toThrow();
    },
    TIMEOUT,
  );

  it(
    "pins an immutable namespace without modifying branches and refuses alias refs",
    () => {
      const pack = capture();
      const before = git(checkout.projectRoot, "show-ref", "--heads");
      pinCodeSnapshot(checkout.projectRoot, pack);
      pinCodeSnapshot(checkout.projectRoot, pack);
      expect(git(checkout.projectRoot, "rev-parse", codeSnapshotRef(pack.id))).toBe(
        checkout.snapshotCommit,
      );
      expect(git(checkout.projectRoot, "show-ref", "--heads")).toBe(before);
      git(checkout.projectRoot, "update-ref", "-d", codeSnapshotRef(pack.id));
      git(checkout.projectRoot, "symbolic-ref", codeSnapshotRef(pack.id), "refs/heads/main");
      expect(() => pinCodeSnapshot(checkout.projectRoot, pack)).toThrow(
        expect.objectContaining({ code: "snapshot_conflict" }),
      );
      expect(git(checkout.projectRoot, "show-ref", "--heads")).toBe(before);
      expect(() => codeSnapshotRef("bad")).toThrow();
    },
    TIMEOUT,
  );

  it(
    "excludes explicitly selected untracked context from code scopes without excluding tracked code",
    () => {
      const path = "docs/agent-context/check.md";
      write(checkout.worktreePath, path, "first notes\n");
      const pack = capture([path]);
      const next = nextCheckout(pack);
      installContextSnapshot({ checkout: next, package: pack });
      const scope = restoreTaskChangeScope(
        serializeTaskChangeScope(
          beginTaskChangeScope(next, { requireClean: true, contextPaths: [path] }),
        ),
        next,
      );
      write(next.worktreePath, path, "updated notes\n");
      write(next.worktreePath, "task.txt", "second step\n");
      const result = commitTaskChanges(scope, "task checkpoint");
      expect(result.paths).toEqual(["task.txt"]);
      if (result.status !== "committed") throw new Error("Missing checkpoint");
      expect(
        git(checkout.projectRoot, "ls-tree", "-r", "--name-only", result.commitSha),
      ).not.toContain(path);
      const changed = captureCodeSnapshotPackage({
        checkout: next,
        commitSha: result.commitSha,
        sourceDeviceId: pack.descriptor.sourceDeviceId,
        notes,
        planText: pack.context.plan.text,
        portablePaths: [path],
      });
      expect(blobText(changed, path)).toBe("updated notes\n");
      expect(() => beginTaskChangeScope(checkout, { contextPaths: ["AGENTS.md"] })).toThrow();
      expect(() => beginTaskChangeScope(checkout, { contextPaths: [".env"] })).toThrow();
    },
    TIMEOUT,
  );
});
