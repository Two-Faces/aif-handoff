import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  prepareTaskCheckout,
  taskGit,
  taskGitText,
  type TaskCheckoutInput,
} from "../taskCheckout.js";
import { beginTaskChangeScope, commitTaskChanges } from "../taskCommit.js";
import { captureCodeSnapshotPackage, codeSnapshotRef } from "../handoff/contextSnapshot.js";
import { continuationNotesSchema, type CodeSnapshotPackage } from "../handoff/contracts.js";
import {
  assertPortableGitSnapshot,
  createSnapshotBundle,
  importSnapshotBundle,
  prepareReceivedSnapshot,
  verifyReceivedSnapshot,
} from "../handoff/gitSnapshot.js";

const TIMEOUT = 30_000;
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
function init(root: string, format = "sha1") {
  mkdirSync(root);
  git(root, "init", "-b", "main", `--object-format=${format}`);
  git(root, "config", "user.name", "Transfer Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(root, "no-hooks"));
  write(root, "code.txt", "base\n");
  write(root, "AGENTS.md", "# Instructions\n");
  write(root, ".gitignore", ".ai-factory/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
}
let directory: string;
let source: string;
let target: string;
let checkout: TaskCheckoutInput;
let pack: CodeSnapshotPackage;
function snapshot(root: string, name: string) {
  const input = {
    projectId: "project",
    taskId: name,
    projectRoot: root,
    worktreePath: join(directory, name),
    snapshotCommit: git(root, "rev-parse", "HEAD"),
  };
  prepareTaskCheckout(input);
  const scope = beginTaskChangeScope(input);
  write(input.worktreePath, "code.txt", "snapshot code\n");
  const committed = commitTaskChanges(scope, "task change");
  if (committed.status !== "committed") throw new Error("Missing checkpoint");
  write(input.worktreePath, ".ai-factory/RULES.md", "portable notes\n");
  return {
    input,
    pack: captureCodeSnapshotPackage({
      checkout: input,
      commitSha: committed.commitSha,
      sourceDeviceId: "74870384-2979-43dc-bb16-299c7f7b3152",
      notes: continuationNotesSchema.parse({ goal: "Transfer", nextStep: "Review" }),
      planText: null,
      portablePaths: [".ai-factory/RULES.md"],
    }),
  };
}
function state(root: string) {
  return {
    head: git(root, "rev-parse", "HEAD"),
    refs: git(
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
    ),
    index: readFileSync(join(root, ".git", "index")),
    status: git(root, "status", "--porcelain=v1"),
  };
}
beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-bundle-")));
  source = join(directory, "source");
  target = join(directory, "target");
  init(source);
  init(target);
  ({ input: checkout, pack } = snapshot(source, "source-task"));
});
afterEach(() => {
  expect(directory.startsWith(realpathSync.native(tmpdir()))).toBe(true);
  rmSync(directory, { recursive: true, force: true });
});

describe("isolated Git snapshot transfer", () => {
  it(
    "imports a full bundle into a divergent dirty repository without moving branches, files or index",
    () => {
      write(target, "code.txt", "divergent branch\n");
      git(target, "add", "code.txt");
      git(target, "commit", "-m", "divergent target");
      write(target, "code.txt", "user staged\n");
      git(target, "add", "code.txt");
      write(target, "code.txt", "user unstaged\n");
      write(target, "unrelated.txt", "keep\n");
      const before = state(target);
      const sourceBefore = state(source);
      const bundle = createSnapshotBundle(source, pack);
      importSnapshotBundle(target, pack, bundle, null);
      importSnapshotBundle(target, pack, bundle, null);
      expect(state(target)).toEqual(before);
      expect(state(source)).toEqual(sourceBefore);
      expect(git(target, "rev-parse", codeSnapshotRef(pack.id))).toBe(pack.descriptor.commitSha);
      const next = {
        ...checkout,
        projectRoot: target,
        worktreePath: join(directory, "received"),
        snapshotCommit: pack.descriptor.commitSha,
      };
      prepareReceivedSnapshot(next, pack);
      expect(readFileSync(join(next.worktreePath, "code.txt"), "utf8")).toBe("snapshot code\n");
      expect(readFileSync(join(next.worktreePath, ".ai-factory/RULES.md"), "utf8")).toBe(
        "portable notes\n",
      );
      verifyReceivedSnapshot(next, pack);
      unlinkSync(join(next.worktreePath, ".ai-factory/RULES.md"));
      expect(() => verifyReceivedSnapshot(next, pack)).toThrow();
      expect(existsSync(join(next.worktreePath, ".ai-factory/RULES.md"))).toBe(false);
      expect(state(target)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "checks incremental prerequisites and accepts the full fallback when the base is absent",
    () => {
      // A distinct base is guaranteed, regardless of commit timestamps.
      const blank = join(directory, "blank");
      mkdirSync(blank);
      git(blank, "init", "-b", "main");
      const delta = createSnapshotBundle(source, pack, true);
      expect(() => importSnapshotBundle(blank, pack, delta, pack.descriptor.baseCommit)).toThrow(
        expect.objectContaining({ code: "snapshot_base_missing" }),
      );
      expect(git(blank, "for-each-ref")).toBe("");
      importSnapshotBundle(blank, pack, createSnapshotBundle(source, pack), null);
      importSnapshotBundle(blank, pack, delta, pack.descriptor.baseCommit);
      expect(git(blank, "rev-parse", codeSnapshotRef(pack.id))).toBe(pack.descriptor.commitSha);
      expect(git(blank, "for-each-ref", "refs/heads")).toBe("");
      expect(existsSync(join(blank, ".git/FETCH_HEAD"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "rejects altered headers and corrupt pack data before publishing refs or changing the target",
    () => {
      const bundle = createSnapshotBundle(source, pack);
      const before = state(target);
      const corrupt = Buffer.from(bundle);
      corrupt[corrupt.length - 5] ^= 1;
      const differentHead = Buffer.from(
        bundle.toString("binary").replace(codeSnapshotRef(pack.id), "refs/heads/attacker"),
        "binary",
      );
      for (const bytes of [Buffer.from("bad bundle"), corrupt, differentHead])
        expect(() => importSnapshotBundle(target, pack, bytes, null)).toThrow();
      expect(git(target, "for-each-ref", "refs/aif")).toBe("");
      expect(state(target)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "blocks symlinks, submodules, case collisions and external/LFS filters without executing them",
    () => {
      const blob = taskGit(source, ["hash-object", "-w", "--stdin"], { input: "content\n" })
        .output.toString()
        .trim();
      const attributes = taskGit(source, ["hash-object", "-w", "--stdin"], {
        input: "*.txt filter=forbidden\n",
      })
        .output.toString()
        .trim();
      const trees = [
        `120000 blob ${blob}\tlink\n`,
        `160000 commit ${checkout.snapshotCommit}\tmodule\n`,
        `100644 blob ${blob}\tFoo.txt\n100644 blob ${blob}\tfoo.txt\n`,
        `100644 blob ${attributes}\t.gitattributes\n100644 blob ${blob}\tx.txt\n`,
        `100644 blob ${blob}\tCON.txt\n`,
      ];
      git(source, "config", "filter.forbidden.clean", "echo executed > forbidden-executed.txt");
      for (const entries of trees) {
        const tree = taskGit(source, ["mktree"], { input: entries }).output.toString().trim();
        const commit = taskGitText(source, [
          "commit-tree",
          tree,
          "-p",
          checkout.snapshotCommit,
          "-m",
          "unsupported fixture",
        ]);
        expect(() => assertPortableGitSnapshot(source, commit)).toThrow(
          expect.objectContaining({ code: "snapshot_unsupported_code" }),
        );
      }
      expect(existsSync(join(source, "forbidden-executed.txt"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "does not invoke destination hooks or filters and refuses to fill context in a dirty reused checkout",
    () => {
      const hooks = join(directory, "hooks");
      mkdirSync(hooks);
      const sentinel = join(directory, "executed.txt").replaceAll("\\", "/");
      write(hooks, "reference-transaction", `#!/bin/sh\nprintf bad > '${sentinel}'\n`);
      chmodSync(join(hooks, "reference-transaction"), 0o755);
      git(target, "config", "core.hooksPath", hooks);
      importSnapshotBundle(target, pack, createSnapshotBundle(source, pack), null);
      expect(existsSync(sentinel)).toBe(false);
      const next = {
        ...checkout,
        projectRoot: target,
        worktreePath: join(directory, "received"),
        snapshotCommit: pack.descriptor.commitSha,
      };
      prepareTaskCheckout(next);
      write(next.worktreePath, "code.txt", "unclaimed edit\n");
      write(target, ".git/info/attributes", "*.txt diff=forbidden\n");
      git(target, "config", "diff.forbidden.textconv", `echo bad > '${sentinel}'`);
      expect(() => prepareReceivedSnapshot(next, pack)).toThrow();
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(next.worktreePath, ".ai-factory/RULES.md"))).toBe(false);
      write(next.worktreePath, ".gitattributes", "*.txt filter=forbidden\n");
      git(target, "config", "filter.forbidden.clean", `echo bad > '${sentinel}'`);
      expect(() => verifyReceivedSnapshot(next, pack)).toThrow();
      expect(existsSync(sentinel)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "supports SHA-256 bundles and fails closed on a target object-format mismatch",
    () => {
      const shaSource = join(directory, "sha-source");
      const shaTarget = join(directory, "sha-target");
      init(shaSource, "sha256");
      init(shaTarget, "sha256");
      const sha = snapshot(shaSource, "sha-task");
      const bundle = createSnapshotBundle(shaSource, sha.pack);
      expect(() => importSnapshotBundle(target, sha.pack, bundle, null)).toThrow(
        expect.objectContaining({ code: "snapshot_format_mismatch" }),
      );
      importSnapshotBundle(shaTarget, sha.pack, bundle, null);
      expect(git(shaTarget, "rev-parse", codeSnapshotRef(sha.pack.id))).toBe(
        sha.pack.descriptor.commitSha,
      );
      expect(sha.pack.descriptor.commitSha).toHaveLength(64);
    },
    TIMEOUT,
  );
});
