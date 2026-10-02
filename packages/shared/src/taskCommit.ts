import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTaskCheckout,
  assertTaskFileAttributes,
  taskCheckpointRef,
  TaskCheckoutError,
  taskGit,
  withTaskIndex,
  type TaskCheckoutInput,
} from "./taskCheckout.js";

const scopeBrand = Symbol("task-change-scope");
export interface TaskChangeScope {
  readonly [scopeBrand]: true;
}
interface FileState {
  mode: string;
  data: Buffer | null;
  fingerprint: string;
}
interface ScopeState {
  checkout: TaskCheckoutInput;
  foreign: Map<string, string>;
  ref: string;
  previousRef: string | null;
}
const scopes = new WeakMap<TaskChangeScope, ScopeState>();

function nulPaths(output: Buffer): string[] {
  const text = output.toString("utf8");
  if (!Buffer.from(text).equals(output)) {
    throw new TaskCheckoutError(
      "unsupported_entry",
      "Non-UTF-8 Git paths cannot be included in a portable task checkpoint.",
    );
  }
  return text.split("\0").filter(Boolean);
}

function dirtyPaths(root: string): string[] {
  const candidates = taskGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]).output;
  assertTaskFileAttributes(root, candidates);
  return [
    ...new Set([
      ...nulPaths(
        taskGit(root, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD", "--"])
          .output,
      ),
      ...nulPaths(taskGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).output),
    ]),
  ].sort();
}

function fileState(root: string, path: string): FileState {
  const segments = path.split("/");
  if (
    !path ||
    segments.some(
      (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git",
    ) ||
    /[\\:\0]/.test(path)
  ) {
    throw new TaskCheckoutError("invalid_path", `Unsafe task path: ${path}`);
  }
  let absolute = root;
  for (const segment of segments) {
    absolute = join(absolute, segment);
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { mode: "0", data: null, fingerprint: "deleted" };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new TaskCheckoutError("unsupported_entry", `Symlink or junction in task path: ${path}`);
    }
    if (absolute !== join(root, ...segments)) continue;
    if (!stats.isFile() || stats.size > 32 * 1024 * 1024) {
      throw new TaskCheckoutError(
        "unsupported_entry",
        `Task path is not a regular file of at most 32 MiB: ${path}`,
      );
    }
  }
  const data = readFileSync(absolute);
  // Match Git's executable-bit policy; Windows checkouts cannot infer it from chmod.
  const indexEntry = taskGit(root, [
    "--literal-pathspecs",
    "ls-tree",
    "HEAD",
    "--",
    path,
  ]).output.toString();
  const fileMode = taskGit(root, ["config", "--bool", "core.filemode"], { allowFailure: true });
  const executable =
    fileMode.output.toString().trim() === "false"
      ? indexEntry.startsWith("100755 ")
      : Boolean(lstatSync(absolute).mode & 0o111);
  const mode = executable ? "100755" : "100644";
  return { mode, data, fingerprint: `${mode}:${createHash("sha256").update(data).digest("hex")}` };
}

function foreignFingerprint(root: string, path: string): string {
  const staged = taskGit(root, [
    "--literal-pathspecs",
    "ls-files",
    "--stage",
    "-z",
    "--",
    path,
  ]).output;
  return `${fileState(root, path).fingerprint}:${createHash("sha256").update(staged).digest("hex")}`;
}

function currentRef(checkout: TaskCheckoutInput, ref: string): string | null {
  const symbolic = taskGit(checkout.worktreePath, ["symbolic-ref", "-q", ref], {
    allowFailure: true,
  });
  if (symbolic.status === 0) {
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "A task checkpoint ref must not alias a user branch.",
    );
  }
  if (symbolic.status !== 1)
    throw new TaskCheckoutError("git_failed", "Cannot inspect the task checkpoint ref.");
  const result = taskGit(checkout.worktreePath, ["rev-parse", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  if (result.status === 1) return null;
  if (result.status !== 0)
    throw new TaskCheckoutError("git_failed", "Cannot read the task checkpoint ref.");
  return result.output.toString().trim();
}

/** Call before the task writes. Existing dirty/staged/untracked paths are foreign.
 * The opaque scope cannot be reconstructed from a model's proposed file list.
 * Restart recovery must create a new checkout from the last accepted checkpoint;
 * it must not claim dirty files by opening a new scope after execution.
 */
export function beginTaskChangeScope(input: TaskCheckoutInput): TaskChangeScope {
  assertTaskCheckout(input);
  const checkout = { ...input };
  const ref = taskCheckpointRef(checkout);
  const previousRef = currentRef(checkout, ref);
  if (previousRef !== null && previousRef !== checkout.snapshotCommit) {
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "Continue from the latest accepted task checkpoint in a new exact-commit checkout.",
    );
  }
  const foreign = new Map(
    dirtyPaths(checkout.worktreePath).map((path) => [
      path,
      foreignFingerprint(checkout.worktreePath, path),
    ]),
  );
  const token = Object.freeze({ [scopeBrand]: true as const });
  scopes.set(token, { checkout, foreign, ref, previousRef });
  return token;
}

export type TaskCommitResult =
  | { status: "no_changes"; commitSha: null; paths: string[] }
  | { status: "committed"; commitSha: string; parentSha: string; ref: string; paths: string[] };

/** Create a local checkpoint object and CAS only refs/aif/tasks/... . HEAD,
 * branches, index and all checkout files remain byte-for-byte untouched.
 * This is snapshot plumbing, not a general git-commit replacement: no project
 * hooks, runtime, filters, push, or PR publication execute here.
 */
export function commitTaskChanges(scope: TaskChangeScope, message: string): TaskCommitResult {
  const state = scopes.get(scope);
  if (!state)
    throw new TaskCheckoutError(
      "identity_mismatch",
      "Missing task change scope from before execution.",
    );
  if (!message.trim() || message.includes("\0"))
    throw new TaskCheckoutError(
      "scope_changed",
      "A checkpoint requires a non-empty commit message without NUL.",
    );
  const { checkout, foreign, ref, previousRef } = state;
  assertTaskCheckout(checkout);
  const root = checkout.worktreePath;
  for (const [path, fingerprint] of foreign) {
    if (foreignFingerprint(root, path) !== fingerprint) {
      throw new TaskCheckoutError(
        "scope_overlap",
        `Task changes overlap pre-existing edits or staged hunks: ${path}`,
      );
    }
  }
  if (currentRef(checkout, ref) !== previousRef) {
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "The task checkpoint advanced after this scope began.",
    );
  }
  const paths = dirtyPaths(root).filter((path) => !foreign.has(path));
  if (paths.length === 0) return { status: "no_changes", commitSha: null, paths: [] };
  const files = new Map(paths.map((path) => [path, fileState(root, path)]));
  return withTaskIndex(root, (indexFile) => {
    taskGit(root, ["read-tree", checkout.snapshotCommit], { indexFile });
    const records: string[] = [];
    // Remove old directory entries before adding a file at that directory path.
    const ordered = [...files].sort(
      (a, b) => Number(a[1].data !== null) - Number(b[1].data !== null),
    );
    for (const [path, file] of ordered) {
      const oid =
        file.data === null
          ? "0".repeat(checkout.snapshotCommit.length)
          : taskGit(root, ["hash-object", "-w", `--path=${path}`, "--stdin"], { input: file.data })
              .output.toString()
              .trim();
      records.push(`${file.mode} ${oid}\t${path}\0`);
    }
    taskGit(root, ["update-index", "-z", "--index-info"], { indexFile, input: records.join("") });
    const tree = taskGit(root, ["write-tree"], { indexFile }).output.toString().trim();
    const actualPaths = nulPaths(
      taskGit(root, [
        "diff-tree",
        "--no-commit-id",
        "--no-renames",
        "--name-only",
        "-r",
        "-z",
        checkout.snapshotCommit,
        tree,
        "--",
      ]).output,
    ).sort();
    if (actualPaths.length === 0) return { status: "no_changes", commitSha: null, paths: [] };
    if (actualPaths.some((path) => !files.has(path))) {
      throw new TaskCheckoutError(
        "scope_changed",
        "The checkpoint tree contains changes outside the task scope.",
      );
    }
    const commitSha = taskGit(
      root,
      ["commit-tree", tree, "-p", checkout.snapshotCommit, "-F", "-"],
      { input: `${message.trim()}\n` },
    )
      .output.toString()
      .trim();
    // Detect drift during object construction before the sole visible write.
    assertTaskCheckout(checkout);
    for (const [path, file] of files) {
      if (fileState(root, path).fingerprint !== file.fingerprint)
        throw new TaskCheckoutError(
          "scope_changed",
          `Task file changed while checkpointing: ${path}`,
        );
    }
    for (const [path, fingerprint] of foreign) {
      if (foreignFingerprint(root, path) !== fingerprint)
        throw new TaskCheckoutError(
          "scope_overlap",
          `Pre-existing edit changed while checkpointing: ${path}`,
        );
    }
    const publish = taskGit(
      root,
      [
        "update-ref",
        "--no-deref",
        ref,
        commitSha,
        previousRef ?? "0".repeat(checkout.snapshotCommit.length),
      ],
      { allowFailure: true },
    );
    if (publish.status !== 0)
      throw new TaskCheckoutError(
        "checkpoint_conflict",
        "The checkpoint ref could not be advanced atomically. Inspect the task ref before retrying.",
      );
    scopes.delete(scope);
    return {
      status: "committed",
      commitSha,
      parentSha: checkout.snapshotCommit,
      ref,
      paths: actualPaths,
    };
  });
}
