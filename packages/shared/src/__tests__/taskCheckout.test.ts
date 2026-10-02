import { execFileSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertTaskCheckout,
  prepareTaskCheckout,
  taskCheckpointRef,
  taskGit,
  TaskCheckoutError,
  type TaskCheckoutInput,
} from "../taskCheckout.js";
import {
  beginTaskChangeScope,
  commitTaskChanges,
  prepareTaskCommit,
  publishTaskCommit,
  serializeTaskChangeScope,
  restoreTaskChangeScope,
  serializeTaskCommitIntent,
  restoreTaskCommitIntent,
  preparedTaskCommitSha,
  preparedTaskCheckpointRefTarget,
  adoptTransferredTaskCheckpoint,
  type TaskChangeScope,
} from "../taskCommit.js";

const TIMEOUT = 20_000;
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function state(root: string) {
  const gitDir = git(root, "rev-parse", "--absolute-git-dir");
  return {
    head: git(root, "rev-parse", "HEAD"),
    headFile: readFileSync(join(gitDir, "HEAD")),
    index: readFileSync(join(gitDir, "index")),
    branches: git(
      root,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
    ),
    dirty: git(root, "diff", "--binary", "HEAD"),
    untracked: git(root, "ls-files", "--others", "--exclude-standard"),
  };
}
function expectCode(run: () => unknown, code: TaskCheckoutError["code"]) {
  try {
    run();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskCheckoutError);
    expect((error as TaskCheckoutError).code).toBe(code);
  }
}

describe("exact task checkouts and scoped checkpoint commits", () => {
  let directory: string;
  let source: string;
  let checkout: TaskCheckoutInput;
  it(
    "adopts a received checkpoint by CAS without user ref/index changes and repeats after a lost acknowledgement",
    () => {
      prepareTaskCheckout(checkout);
      const empty = prepareTaskCommit(beginTaskChangeScope(checkout), "empty");
      expect(preparedTaskCommitSha(empty)).toBe(checkout.snapshotCommit);
      expect(preparedTaskCheckpointRefTarget(empty)).toBeNull();
      expectCode(() => preparedTaskCommitSha({} as never), "invalid_scope");
      expectCode(() => preparedTaskCheckpointRefTarget({} as never), "invalid_scope");
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "received change\n");
      const intent = prepareTaskCommit(scope, "received checkpoint");
      const received = {
        ...checkout,
        worktreePath: join(directory, "received"),
        snapshotCommit: preparedTaskCommitSha(intent),
      };
      prepareTaskCheckout(received);
      const before = state(source);
      write(source, ".git/hooks/reference-transaction", "#!/bin/sh\nexit 19\n");
      chmodSync(join(source, ".git/hooks/reference-transaction"), 0o755);
      adoptTransferredTaskCheckpoint(received, null, checkout.snapshotCommit);
      adoptTransferredTaskCheckpoint(received, null, checkout.snapshotCommit);
      expect(git(source, "rev-parse", taskCheckpointRef(received))).toBe(received.snapshotCommit);
      expect(state(source)).toEqual(before);
      expect(() => beginTaskChangeScope(received, { requireClean: true })).not.toThrow();
    },
    TIMEOUT,
  );
  it(
    "rejects unrelated checkpoint ancestry, aliases and an unexpected local checkpoint",
    () => {
      prepareTaskCheckout(checkout);
      const tree = git(source, "rev-parse", `${checkout.snapshotCommit}^{tree}`);
      const orphan = git(
        source,
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-m",
        "unrelated",
      );
      const received = {
        ...checkout,
        worktreePath: join(directory, "received"),
        snapshotCommit: orphan,
      };
      prepareTaskCheckout(received);
      const ref = taskCheckpointRef(checkout);
      git(source, "update-ref", ref, checkout.snapshotCommit);
      expectCode(
        () => adoptTransferredTaskCheckpoint(received, checkout.snapshotCommit),
        "checkpoint_conflict",
      );
      expectCode(() => adoptTransferredTaskCheckpoint(received, null), "checkpoint_conflict");
      expectCode(() => adoptTransferredTaskCheckpoint(received, "invalid"), "invalid_scope");
      git(source, "symbolic-ref", ref, "refs/heads/main");
      expectCode(
        () => adoptTransferredTaskCheckpoint(received, checkout.snapshotCommit),
        "checkpoint_conflict",
      );
      expect(git(source, "rev-parse", "main")).toBe(checkout.snapshotCommit);
    },
    TIMEOUT,
  );
  beforeEach(() => {
    directory = realpathSync.native(mkdtempSync(join(tmpdir(), "aif-task-checkpoint-")));
    source = join(directory, "source");
    mkdirSync(source);
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Checkpoint Test");
    git(source, "config", "user.email", "test@example.invalid");
    git(source, "config", "core.autocrlf", "false");
    git(source, "config", "core.filemode", "false");
    write(source, "task.txt", "base task\n");
    write(source, "foreign.txt", "base foreign\n");
    write(source, "remove.txt", "delete in task\n");
    write(source, "AGENTS.md", "committed instructions\n");
    write(source, ".gitignore", "ignored/\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "fixture base");
    checkout = {
      projectRoot: source,
      worktreePath: join(directory, "task"),
      projectId: "project-1",
      taskId: "task-1",
      snapshotCommit: git(source, "rev-parse", "HEAD"),
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    // The only recursive cleanup target is our OS-generated fixture directory.
    expect(resolve(directory).startsWith(realpathSync.native(tmpdir()))).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });

  it(
    "restores the pre-execution whitelist instead of adopting the current dirty tree",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "foreign.txt", "preexisting edit\n");
      const json = serializeTaskChangeScope(beginTaskChangeScope(checkout));
      write(checkout.worktreePath, "task.txt", "owned after baseline\n");
      const restored = restoreTaskChangeScope(json, checkout);
      const result = commitTaskChanges(restored, "restored scope");
      if (result.status !== "committed") throw new Error("Expected checkpoint");
      expect(result.paths).toEqual(["task.txt"]);
      expect(git(source, "show", `${result.commitSha}:foreign.txt`)).toBe("base foreign");
    },
    TIMEOUT,
  );

  it(
    "persists intent before publication and recovers the same commit after a lost acknowledgement",
    () => {
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "durable task\n");
      const intent = prepareTaskCommit(scope, "durable checkpoint");
      const json = serializeTaskCommitIntent(intent);
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
      const first = publishTaskCommit(restoreTaskCommitIntent(json, checkout));
      const recovered = publishTaskCommit(restoreTaskCommitIntent(json, checkout));
      expect(recovered).toEqual(first);
      if (first.status !== "committed") throw new Error("Expected checkpoint");
      expect(
        git(source, "rev-list", "--count", `${checkout.snapshotCommit}..${first.commitSha}`),
      ).toBe("1");
    },
    TIMEOUT,
  );

  it(
    "rejects corrupt, cross-task and overlapping saved provenance",
    () => {
      prepareTaskCheckout(checkout);
      const scopeJson = serializeTaskChangeScope(beginTaskChangeScope(checkout));
      expectCode(() => restoreTaskChangeScope("null", checkout), "invalid_scope");
      expectCode(
        () => restoreTaskChangeScope(scopeJson, { ...checkout, taskId: "other" }),
        "identity_mismatch",
      );
      const invalid = JSON.parse(scopeJson);
      invalid.version = 2;
      expectCode(() => restoreTaskChangeScope(JSON.stringify(invalid), checkout), "invalid_scope");
      write(checkout.worktreePath, "task.txt", "prepared\n");
      const intentJson = serializeTaskCommitIntent(
        prepareTaskCommit(restoreTaskChangeScope(scopeJson, checkout), "prepare"),
      );
      const duplicated = JSON.parse(intentJson);
      duplicated.paths.push(duplicated.paths[0]);
      expectCode(
        () => restoreTaskCommitIntent(JSON.stringify(duplicated), checkout),
        "invalid_scope",
      );
      const tampered = JSON.parse(intentJson);
      tampered.treeSha = "0".repeat(40);
      expectCode(
        () => publishTaskCommit(restoreTaskCommitIntent(JSON.stringify(tampered), checkout)),
        "invalid_scope",
      );
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "does not publish an old intent after further task writes or overlapping foreign edits",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "foreign.txt", "foreign\n");
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "prepared\n");
      const intent = prepareTaskCommit(scope, "prepared");
      write(checkout.worktreePath, "later.txt", "arrived too late\n");
      expectCode(() => publishTaskCommit(intent), "scope_changed");
      unlinkSync(join(checkout.worktreePath, "later.txt"));
      write(checkout.worktreePath, "foreign.txt", "overlapped\n");
      expectCode(() => publishTaskCommit(intent), "scope_overlap");
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "creates a detached exact snapshot without touching dirty source state or copying mutable context",
    () => {
      write(source, "foreign.txt", "user staged\n");
      git(source, "add", "foreign.txt");
      write(source, "foreign.txt", "user staged\nuser unstaged\n");
      write(source, "private.txt", "untracked secret\n");
      write(source, "AGENTS.md", "mutable source instructions\n");
      write(source, "ignored/local.json", "local-only\n");
      const before = state(source);
      expect(prepareTaskCheckout(checkout).action).toBe("created");
      expect(git(checkout.worktreePath, "rev-parse", "HEAD")).toBe(checkout.snapshotCommit);
      expect(git(checkout.worktreePath, "branch", "--show-current")).toBe("");
      expect(readFileSync(join(checkout.worktreePath, "AGENTS.md"), "utf8")).toBe(
        "committed instructions\n",
      );
      expect(existsSync(join(checkout.worktreePath, "private.txt"))).toBe(false);
      expect(existsSync(join(checkout.worktreePath, "ignored"))).toBe(false);
      expect(state(source)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "reuses task changes and deleted context without overlaying the source",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "AGENTS.md", "task-owned instructions\n");
      unlinkSync(join(checkout.worktreePath, "task.txt"));
      const before = state(checkout.worktreePath);
      expect(prepareTaskCheckout(checkout).action).toBe("reused");
      expect(state(checkout.worktreePath)).toEqual(before);
      expect(readFileSync(join(checkout.worktreePath, "AGENTS.md"), "utf8")).toBe(
        "task-owned instructions\n",
      );
    },
    TIMEOUT,
  );

  it(
    "rejects branch names, abbreviated IDs, tags and missing commits before creating a directory",
    () => {
      for (const snapshotCommit of [
        "main",
        checkout.snapshotCommit.slice(0, 12),
        "HEAD^{commit}",
        "0".repeat(40),
      ]) {
        expectCode(() => prepareTaskCheckout({ ...checkout, snapshotCommit }), "invalid_snapshot");
      }
      expect(existsSync(checkout.worktreePath)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "never adopts another existing directory or task's checkout",
    () => {
      mkdirSync(checkout.worktreePath);
      write(checkout.worktreePath, "keep.txt", "user\n");
      expectCode(() => prepareTaskCheckout(checkout), "identity_mismatch");
      expect(readFileSync(join(checkout.worktreePath, "keep.txt"), "utf8")).toBe("user\n");
      checkout.worktreePath = join(directory, "actual-task");
      prepareTaskCheckout(checkout);
      expectCode(
        () => prepareTaskCheckout({ ...checkout, taskId: "other-task" }),
        "identity_mismatch",
      );
      const marker = join(
        git(checkout.worktreePath, "rev-parse", "--absolute-git-dir"),
        "aif-task-checkout.json",
      );
      writeFileSync(marker, "{broken");
      expectCode(() => assertTaskCheckout(checkout), "identity_mismatch");
    },
    TIMEOUT,
  );

  it(
    "rejects a branch or different HEAD in a registered checkout even when its contents are clean",
    () => {
      prepareTaskCheckout(checkout);
      git(checkout.worktreePath, "switch", "-c", "task-label");
      expectCode(() => assertTaskCheckout(checkout), "head_drift");
      git(checkout.worktreePath, "checkout", "--detach");
      write(checkout.worktreePath, "task.txt", "unregistered commit\n");
      git(checkout.worktreePath, "add", "task.txt");
      git(checkout.worktreePath, "commit", "-m", "foreign commit");
      const before = state(checkout.worktreePath);
      expectCode(() => prepareTaskCheckout(checkout), "head_drift");
      expect(state(checkout.worktreePath)).toEqual(before);
    },
    TIMEOUT,
  );

  it(
    "rejects unsafe destinations and a junction into the source",
    () => {
      for (const worktreePath of [
        source,
        join(source, "nested-task"),
        directory,
        "relative-path",
      ]) {
        expectCode(() => prepareTaskCheckout({ ...checkout, worktreePath }), "invalid_path");
      }
      const link = join(directory, "junction");
      symlinkSync(source, link, "junction");
      expectCode(
        () => prepareTaskCheckout({ ...checkout, worktreePath: join(link, "task") }),
        "invalid_path",
      );
      expectCode(
        () => prepareTaskCheckout({ ...checkout, projectRoot: join(source, ".git") }),
        "git_failed",
      );
    },
    TIMEOUT,
  );

  it(
    "rejects worktree configuration that redirects the working root",
    () => {
      prepareTaskCheckout(checkout);
      git(source, "config", "extensions.worktreeConfig", "true");
      git(checkout.worktreePath, "config", "--worktree", "core.worktree", source);
      expectCode(() => assertTaskCheckout(checkout), "identity_mismatch");
    },
    TIMEOUT,
  );

  it(
    "checkpoints a directory-to-file replacement with explicit deletions first",
    () => {
      write(source, "folder/old.txt", "old nested file\n");
      git(source, "add", "folder/old.txt");
      git(source, "commit", "-m", "directory fixture");
      checkout.snapshotCommit = git(source, "rev-parse", "HEAD");
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      unlinkSync(join(checkout.worktreePath, "folder/old.txt"));
      rmdirSync(join(checkout.worktreePath, "folder"));
      write(checkout.worktreePath, "folder", "now a regular file\n");
      const result = commitTaskChanges(scope, "replace directory");
      if (result.status !== "committed") throw new Error("Expected checkpoint");
      expect(result.paths).toEqual(["folder", "folder/old.txt"]);
      expect(git(source, "show", `${result.commitSha}:folder`)).toBe("now a regular file");
    },
    TIMEOUT,
  );

  it(
    "rejects nesting in another registered checkout when the project binding is itself a worktree",
    () => {
      const binding = join(directory, "linked-binding");
      git(source, "worktree", "add", "--detach", binding, checkout.snapshotCommit);
      const sourceBefore = state(source);
      expectCode(
        () =>
          prepareTaskCheckout({
            ...checkout,
            projectRoot: binding,
            worktreePath: join(source, "nested-task"),
          }),
        "invalid_path",
      );
      expect(state(source)).toEqual(sourceBefore);
      expect(existsSync(join(source, "nested-task"))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "supports full SHA-256 commit IDs without assuming a SHA-1 ref sentinel",
    () => {
      const sha256Root = join(directory, "sha256");
      mkdirSync(sha256Root);
      git(sha256Root, "init", "--object-format=sha256", "-b", "main");
      git(sha256Root, "config", "user.name", "Checkpoint Test");
      git(sha256Root, "config", "user.email", "test@example.invalid");
      write(sha256Root, "file.txt", "initial\n");
      git(sha256Root, "add", "file.txt");
      git(sha256Root, "commit", "-m", "base");
      const input = {
        ...checkout,
        projectRoot: sha256Root,
        snapshotCommit: git(sha256Root, "rev-parse", "HEAD"),
      };
      expect(input.snapshotCommit).toHaveLength(64);
      prepareTaskCheckout(input);
      const scope = beginTaskChangeScope(input);
      write(input.worktreePath, "file.txt", "SHA-256 task\n");
      const result = commitTaskChanges(scope, "SHA-256 checkpoint");
      if (result.status !== "committed") throw new Error("Expected checkpoint");
      expect(result.commitSha).toHaveLength(64);
      expect(git(sha256Root, "rev-parse", `${result.commitSha}^`)).toBe(input.snapshotCommit);
    },
    TIMEOUT,
  );

  it(
    "does not execute a post-checkout hook while preparing the snapshot",
    () => {
      const marker = join(directory, "hook-ran").replaceAll("\\", "/");
      write(source, ".git/hooks/post-checkout", `#!/bin/sh\nprintf ran > '${marker}'\n`);
      chmodSync(join(source, ".git/hooks/post-checkout"), 0o755);
      git(source, "hook", "run", "post-checkout");
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      prepareTaskCheckout(checkout);
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "does not run reference-transaction hooks while publishing a local checkpoint",
    () => {
      prepareTaskCheckout(checkout);
      const marker = join(directory, "ref-hook-ran").replaceAll("\\", "/");
      write(source, ".git/hooks/reference-transaction", `#!/bin/sh\nprintf ran > '${marker}'\n`);
      chmodSync(join(source, ".git/hooks/reference-transaction"), 0o755);
      git(source, "hook", "run", "reference-transaction");
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "owned\n");
      expect(commitTaskChanges(scope, "local checkpoint").status).toBe("committed");
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "rejects configured filters before checkout or dirty-file inspection can execute them",
    () => {
      write(source, ".gitattributes", "*.txt filter=blocked\n");
      git(source, "add", ".gitattributes");
      git(source, "commit", "-m", "filter fixture");
      const filtered = { ...checkout, snapshotCommit: git(source, "rev-parse", "HEAD") };
      const marker = join(directory, "filter-ran").replaceAll("\\", "/");
      git(source, "config", "filter.blocked.smudge", `printf ran > '${marker}'`);
      git(source, "config", "filter.blocked.clean", `printf ran > '${marker}'`);
      expectCode(() => prepareTaskCheckout(filtered), "unsupported_entry");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(checkout.worktreePath)).toBe(false);
      // The older exact snapshot has no filter, so it remains usable.
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, ".gitattributes", "*.txt filter=blocked\n");
      write(checkout.worktreePath, "task.txt", "must not run clean filter\n");
      expectCode(() => beginTaskChangeScope(checkout), "unsupported_entry");
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "uses Git's built-in line ending normalization without external filters",
    () => {
      git(source, "config", "core.autocrlf", "true");
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "windows change\r\n");
      const result = commitTaskChanges(scope, "line endings");
      if (result.status !== "committed") throw new Error("Expected checkpoint");
      expect(taskGit(source, ["show", `${result.commitSha}:task.txt`]).output.toString()).toBe(
        "windows change\n",
      );
    },
    TIMEOUT,
  );

  it(
    "rejects snapshots containing submodule entries before preparing the checkout",
    () => {
      git(
        source,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${checkout.snapshotCommit},module`,
      );
      git(source, "commit", "-m", "submodule fixture");
      checkout.snapshotCommit = git(source, "rev-parse", "HEAD");
      expectCode(() => prepareTaskCheckout(checkout), "unsupported_entry");
      expect(existsSync(checkout.worktreePath)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "ignores inherited Git overrides so they cannot redirect writes into a user's index",
    () => {
      const foreignIndex = join(directory, "external-index");
      writeFileSync(foreignIndex, "do not touch");
      vi.stubEnv("GIT_INDEX_FILE", foreignIndex);
      vi.stubEnv("GIT_WORK_TREE", directory);
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "owned\n");
      expect(commitTaskChanges(scope, "fix: task").status).toBe("committed");
      expect(readFileSync(foreignIndex, "utf8")).toBe("do not touch");
    },
    TIMEOUT,
  );

  it(
    "checkpoints only new task changes, preserving foreign staged hunks, index, files and all branches",
    () => {
      prepareTaskCheckout(checkout);
      const root = checkout.worktreePath;
      write(root, "foreign.txt", "foreign staged\n");
      git(root, "add", "foreign.txt");
      write(root, "foreign.txt", "foreign staged\nforeign unstaged\n");
      write(root, "unrelated.txt", "foreign untracked\n");
      const scope = beginTaskChangeScope(checkout);
      write(root, "task.txt", "task change\n");
      write(root, "new space.txt", Buffer.from([0, 1, 128, 255]));
      write(root, "[literal].txt", "literal path\n");
      write(root, "кириллица.txt", "portable UTF-8\n");
      unlinkSync(join(root, "remove.txt"));
      const sourceBefore = state(source);
      const before = state(root);
      const result = commitTaskChanges(scope, "fix: scoped task checkpoint");
      expect(result.status).toBe("committed");
      if (result.status !== "committed") throw new Error("Expected checkpoint");
      expect(result.paths).toEqual([
        "[literal].txt",
        "new space.txt",
        "remove.txt",
        "task.txt",
        "кириллица.txt",
      ]);
      expect(git(root, "show", `${result.commitSha}:foreign.txt`)).toBe("base foreign");
      expect(git(root, "ls-tree", "--name-only", result.commitSha)).not.toContain("unrelated.txt");
      expect(git(root, "rev-parse", `${result.commitSha}^`)).toBe(checkout.snapshotCommit);
      expect(git(root, "rev-parse", result.ref)).toBe(result.commitSha);
      expect(state(root)).toEqual(before);
      expect(state(source)).toEqual(sourceBefore);
      expect(readFileSync(join(root, "foreign.txt"), "utf8")).toBe(
        "foreign staged\nforeign unstaged\n",
      );
      expect(
        readdirSync(git(root, "rev-parse", "--absolute-git-dir")).some((name) =>
          name.startsWith("aif-checkpoint-"),
        ),
      ).toBe(false);
      expectCode(() => commitTaskChanges(scope, "retry consumed scope"), "identity_mismatch");
    },
    TIMEOUT,
  );

  it(
    "blocks same-file overlap with user edits and leaves Git state unchanged",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "task.txt", "user staged hunk\n");
      git(checkout.worktreePath, "add", "task.txt");
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "user staged hunk\ntask hunk\n");
      const before = state(checkout.worktreePath);
      expectCode(() => commitTaskChanges(scope, "must block"), "scope_overlap");
      expect(state(checkout.worktreePath)).toEqual(before);
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "blocks staged-hunk changes even when working file contents did not change",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "foreign.txt", "user working file\n");
      const scope = beginTaskChangeScope(checkout);
      git(checkout.worktreePath, "add", "foreign.txt");
      expectCode(() => commitTaskChanges(scope, "must block"), "scope_overlap");
    },
    TIMEOUT,
  );

  it(
    "returns no_changes for unchanged scopes and rejects fabricated scopes/messages",
    () => {
      prepareTaskCheckout(checkout);
      write(checkout.worktreePath, "foreign.txt", "preexisting\n");
      const scope = beginTaskChangeScope(checkout);
      expect(commitTaskChanges(scope, "nothing new")).toEqual({
        status: "no_changes",
        commitSha: null,
        paths: [],
      });
      expectCode(() => commitTaskChanges({} as TaskChangeScope, "fabricated"), "identity_mismatch");
      expectCode(() => commitTaskChanges(scope, " \n"), "scope_changed");
      expectCode(() => commitTaskChanges(scope, "bad\0message"), "scope_changed");
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
    },
    TIMEOUT,
  );

  it(
    "creates a verified linear checkpoint sequence from separate exact snapshot checkouts",
    () => {
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      const staleScope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "first\n");
      const first = commitTaskChanges(scope, "first checkpoint");
      if (first.status !== "committed") throw new Error("Expected first");
      expectCode(() => commitTaskChanges(staleScope, "stale checkpoint"), "checkpoint_conflict");
      expectCode(() => beginTaskChangeScope(checkout), "checkpoint_conflict");
      const next = {
        ...checkout,
        snapshotCommit: first.commitSha,
        worktreePath: join(directory, "next"),
      };
      prepareTaskCheckout(next);
      const nextScope = beginTaskChangeScope(next);
      write(next.worktreePath, "task.txt", "second\n");
      const second = commitTaskChanges(nextScope, "second checkpoint");
      if (second.status !== "committed") throw new Error("Expected second");
      expect(second.parentSha).toBe(first.commitSha);
      expect(
        git(source, "rev-list", "--count", `${checkout.snapshotCommit}..${second.commitSha}`),
      ).toBe("2");
      expect(git(source, "rev-parse", taskCheckpointRef(checkout))).toBe(second.commitSha);
      expect(git(source, "rev-parse", "main")).toBe(checkout.snapshotCommit);
    },
    TIMEOUT,
  );

  it(
    "preserves state after object creation when the checkpoint ref is locked",
    () => {
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "owned\n");
      const ref = taskCheckpointRef(checkout);
      write(source, `.git/${ref}.lock`, "lock held elsewhere\n");
      const before = state(checkout.worktreePath);
      expectCode(() => commitTaskChanges(scope, "locked checkpoint"), "checkpoint_conflict");
      expect(state(checkout.worktreePath)).toEqual(before);
      expect(git(source, "for-each-ref", "refs/aif")).toBe("");
      unlinkSync(join(source, `.git/${ref}.lock`));
      expect(commitTaskChanges(scope, "retry checkpoint").status).toBe("committed");
    },
    TIMEOUT,
  );

  it(
    "rejects a checkpoint ref that aliases a user branch",
    () => {
      prepareTaskCheckout(checkout);
      const ref = taskCheckpointRef(checkout);
      git(source, "symbolic-ref", ref, "refs/heads/main");
      const before = state(source);
      expectCode(() => beginTaskChangeScope(checkout), "checkpoint_conflict");
      expect(state(source)).toEqual(before);
      expect(git(source, "symbolic-ref", ref)).toBe("refs/heads/main");
    },
    TIMEOUT,
  );

  it(
    "ignores replacement objects when preparing an immutable snapshot",
    () => {
      write(source, "task.txt", "replacement content\n");
      git(source, "add", "task.txt");
      git(source, "commit", "-m", "replacement commit");
      const replacement = git(source, "rev-parse", "HEAD");
      git(source, "replace", checkout.snapshotCommit, replacement);
      expect(git(source, "show", `${checkout.snapshotCommit}:task.txt`)).toBe(
        "replacement content",
      );
      prepareTaskCheckout(checkout);
      expect(readFileSync(join(checkout.worktreePath, "task.txt"), "utf8")).toBe("base task\n");
    },
    TIMEOUT,
  );

  it(
    "retains safe state when Git identity is invalid and removes the temporary index",
    () => {
      prepareTaskCheckout(checkout);
      const scope = beginTaskChangeScope(checkout);
      write(checkout.worktreePath, "task.txt", "owned\n");
      git(source, "config", "user.name", "");
      const before = state(checkout.worktreePath);
      expectCode(() => commitTaskChanges(scope, "identity error"), "git_failed");
      expect(state(checkout.worktreePath)).toEqual(before);
      expect(
        readdirSync(git(checkout.worktreePath, "rev-parse", "--absolute-git-dir")).some((name) =>
          name.startsWith("aif-checkpoint-"),
        ),
      ).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "returns structured spawn failure without parsing Git error messages",
    () => {
      const result = taskGit(source, ["not-a-real-subcommand"], { allowFailure: true });
      expect(result.status).not.toBe(0);
      expectCode(() => taskGit(source, ["not-a-real-subcommand"]), "git_failed");
    },
    TIMEOUT,
  );
});
