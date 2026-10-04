import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { portableContextPathSchema } from "./handoff/contracts.js";
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
  contextPaths: string[];
}
const scopes = new WeakMap<TaskChangeScope, ScopeState>();

const oidSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const checkoutSchema = z
  .object({
    projectRoot: z.string().min(1),
    worktreePath: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    snapshotCommit: oidSchema,
  })
  .strict();
const fingerprintSchema = z.string().regex(/^(?:deleted|100(?:644|755):[0-9a-f]{64})$/);
const foreignSchema = z.tuple([
  z.string().min(1),
  z.string().regex(/^(?:deleted|100(?:644|755):[0-9a-f]{64}):[0-9a-f]{64}$/),
]);
const scopeSchema = z
  .object({
    version: z.literal(1),
    checkout: checkoutSchema,
    foreign: z.array(foreignSchema).max(100_000),
    previousRef: oidSchema.nullable(),
    contextPaths: z.array(portableContextPathSchema).max(512).default([]),
  })
  .strict();
type StoredScope = z.infer<typeof scopeSchema>;
const intentSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    commitSha: oidSchema.nullable(),
    treeSha: oidSchema.nullable(),
    paths: z.array(z.string().min(1)).max(100_000),
    files: z.array(z.tuple([z.string().min(1), fingerprintSchema])).max(100_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.commitSha === null) !== (value.treeSha === null) ||
      (value.commitSha === null && value.paths.length !== 0)
    ) {
      ctx.addIssue({ code: "custom", message: "Inconsistent checkpoint intent" });
    }
  });
type StoredIntent = z.infer<typeof intentSchema>;
const intentBrand = Symbol("task-commit-intent");
export interface TaskCommitIntent {
  readonly [intentBrand]: true;
}
const intents = new WeakMap<
  TaskCommitIntent,
  { stored: StoredIntent; sourceScope?: TaskChangeScope }
>();

function scopeRecord(state: ScopeState): StoredScope {
  return {
    version: 1,
    checkout: { ...state.checkout },
    foreign: [...state.foreign],
    previousRef: state.previousRef,
    contextPaths: state.contextPaths,
  };
}

function decodeRecord<T>(json: string, schema: z.ZodType<T>): T {
  try {
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error("Record too large");
    return schema.parse(JSON.parse(json));
  } catch {
    throw new TaskCheckoutError(
      "invalid_scope",
      "Invalid or unsupported local checkpoint journal record.",
    );
  }
}

function validateStoredScope(stored: StoredScope, expected: TaskCheckoutInput): ScopeState {
  for (const key of Object.keys(expected) as (keyof TaskCheckoutInput)[]) {
    if (stored.checkout[key] !== expected[key])
      throw new TaskCheckoutError(
        "identity_mismatch",
        "The saved scope belongs to another checkout.",
      );
  }
  if (
    new Set(stored.foreign.map(([path]) => path)).size !== stored.foreign.length ||
    (stored.previousRef !== null && stored.previousRef !== stored.checkout.snapshotCommit)
  ) {
    throw new TaskCheckoutError("invalid_scope", "Invalid pre-execution scope baseline.");
  }
  assertTaskCheckout(expected);
  validateContextExclusions(expected, stored.contextPaths);
  return {
    checkout: stored.checkout,
    foreign: new Map(stored.foreign),
    ref: taskCheckpointRef(expected),
    previousRef: stored.previousRef,
    contextPaths: stored.contextPaths,
  };
}

function validateContextExclusions(checkout: TaskCheckoutInput, paths: string[]): void {
  if (paths.length === 0) return;
  if (paths.length > 512 || new Set(paths.map((path) => path.toLowerCase())).size !== paths.length)
    throw new TaskCheckoutError("invalid_scope", "Too many or duplicate portable context paths");
  const tracked = new Set(
    nulPaths(
      taskGit(checkout.worktreePath, ["ls-tree", "-rz", "--name-only", checkout.snapshotCommit])
        .output,
    ).map((path) => path.toLowerCase()),
  );
  for (const path of paths) {
    if (!portableContextPathSchema.safeParse(path).success || tracked.has(path.toLowerCase())) {
      throw new TaskCheckoutError(
        "invalid_scope",
        "Only allowlisted, untracked portable context may be excluded from code commits",
      );
    }
  }
}

/** Host-only persistence interface. Never accept this JSON from an API, peer or
 * model: ownership provenance must come from the local database journal. */
export function serializeTaskChangeScope(scope: TaskChangeScope): string {
  const state = scopes.get(scope);
  if (!state) throw new TaskCheckoutError("invalid_scope", "Unknown task change scope.");
  return JSON.stringify(scopeRecord(state));
}

export function restoreTaskChangeScope(json: string, expected: TaskCheckoutInput): TaskChangeScope {
  const state = validateStoredScope(decodeRecord(json, scopeSchema), expected);
  const token = Object.freeze({ [scopeBrand]: true as const });
  scopes.set(token, state);
  return token;
}

function saveIntent(stored: StoredIntent, sourceScope?: TaskChangeScope): TaskCommitIntent {
  const token = Object.freeze({ [intentBrand]: true as const });
  intents.set(token, { stored, sourceScope });
  return token;
}

export function serializeTaskCommitIntent(intent: TaskCommitIntent): string {
  const state = intents.get(intent);
  if (!state) throw new TaskCheckoutError("invalid_scope", "Unknown checkpoint intent.");
  return JSON.stringify(state.stored);
}

/** Exact immutable object prepared by the host; does not publish any ref. */
export function preparedTaskCommitSha(intent: TaskCommitIntent): string {
  const state = intents.get(intent);
  if (!state) throw new TaskCheckoutError("invalid_scope", "Unknown checkpoint intent.");
  return state.stored.commitSha ?? state.stored.scope.checkout.snapshotCommit;
}
export function preparedTaskCheckpointRefTarget(intent: TaskCommitIntent): string | null {
  const state = intents.get(intent);
  if (!state) throw new TaskCheckoutError("invalid_scope", "Unknown checkpoint intent.");
  return state.stored.commitSha ?? state.stored.scope.previousRef;
}

export function restoreTaskCommitIntent(
  json: string,
  expected: TaskCheckoutInput,
): TaskCommitIntent {
  const stored = decodeRecord(json, intentSchema);
  validateStoredScope(stored.scope, expected);
  const filePaths = new Set(stored.files.map(([path]) => path));
  if (
    filePaths.size !== stored.files.length ||
    new Set(stored.paths).size !== stored.paths.length ||
    stored.paths.some((path) => !filePaths.has(path)) ||
    stored.files.some(
      ([path]) =>
        stored.scope.foreign.some(([foreign]) => foreign === path) ||
        stored.scope.contextPaths.includes(path),
    )
  ) {
    throw new TaskCheckoutError(
      "invalid_scope",
      "The saved checkpoint contains overlapping or duplicate paths.",
    );
  }
  return saveIntent(stored);
}

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

/** Host-only adoption after a durable handoff acceptance intent. Advances only
 * this task's internal ref by CAS; user HEAD/branches/index/files stay untouched.
 * Repeating after publication without DB acknowledgement is safe. */
export function adoptTransferredTaskCheckpoint(
  checkout: TaskCheckoutInput,
  expectedRef: string | null,
  previousCommit: string | null = expectedRef,
): void {
  assertTaskCheckout(checkout);
  if (
    (expectedRef !== null && !oidSchema.safeParse(expectedRef).success) ||
    (previousCommit !== null && !oidSchema.safeParse(previousCommit).success)
  )
    throw new TaskCheckoutError("invalid_scope", "Invalid checkpoint predecessor.");
  const ref = taskCheckpointRef(checkout),
    current = currentRef(checkout, ref);
  if (
    previousCommit &&
    taskGit(
      checkout.worktreePath,
      ["merge-base", "--is-ancestor", previousCommit, checkout.snapshotCommit],
      { allowFailure: true },
    ).status !== 0
  )
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "The received snapshot does not extend the local checkpoint.",
    );
  if (current === checkout.snapshotCommit) return;
  if (current !== expectedRef)
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "The local task checkpoint changed before acceptance.",
    );
  const result = taskGit(
    checkout.worktreePath,
    [
      "update-ref",
      "--no-deref",
      ref,
      checkout.snapshotCommit,
      expectedRef ?? "0".repeat(checkout.snapshotCommit.length),
    ],
    { allowFailure: true },
  );
  if (result.status !== 0)
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "The received checkpoint could not be adopted atomically.",
    );
}

/** Call before the task writes. Existing dirty/staged/untracked paths are foreign.
 * The opaque scope cannot be reconstructed from a model's proposed file list.
 * Persist serializeTaskChangeScope() before allowing writes. Restart recovery
 * restores that exact baseline; it never captures a new baseline after execution.
 */
export function beginTaskChangeScope(
  input: TaskCheckoutInput,
  options: { requireClean?: boolean; contextPaths?: string[] } = {},
): TaskChangeScope {
  assertTaskCheckout(input);
  const checkout = { ...input };
  const ref = taskCheckpointRef(checkout);
  const previousRef = currentRef(checkout, ref);
  const contextPaths = [...(options.contextPaths ?? [])].sort();
  validateContextExclusions(checkout, contextPaths);
  if (previousRef !== null && previousRef !== checkout.snapshotCommit) {
    throw new TaskCheckoutError(
      "checkpoint_conflict",
      "Continue from the latest accepted task checkpoint in a new exact-commit checkout.",
    );
  }
  const foreign = new Map(
    dirtyPaths(checkout.worktreePath)
      .filter((path) => !contextPaths.includes(path))
      .map((path) => [path, foreignFingerprint(checkout.worktreePath, path)]),
  );
  if (options.requireClean && foreign.size !== 0) {
    throw new TaskCheckoutError(
      "scope_overlap",
      "A new execution workspace must be clean before its first scope is recorded.",
    );
  }
  const token = Object.freeze({ [scopeBrand]: true as const });
  scopes.set(token, { checkout, foreign, ref, previousRef, contextPaths });
  return token;
}

export type TaskCommitResult =
  | { status: "no_changes"; commitSha: null; paths: string[] }
  | { status: "committed"; commitSha: string; parentSha: string; ref: string; paths: string[] };

/** Build a local checkpoint object and publication intent without advancing refs.
 * Persist the intent before publishTaskCommit(); HEAD, branches, index and files stay untouched.
 * This is snapshot plumbing, not a general git-commit replacement: no project
 * hooks, runtime, filters, push, or PR publication execute here.
 */
export function prepareTaskCommit(scope: TaskChangeScope, message: string): TaskCommitIntent {
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
  const paths = dirtyPaths(root).filter(
    (path) => !foreign.has(path) && !state.contextPaths.includes(path),
  );
  const emptyIntent = (files: [string, string][] = []): TaskCommitIntent =>
    saveIntent(
      { version: 1, scope: scopeRecord(state), commitSha: null, treeSha: null, paths: [], files },
      scope,
    );
  if (paths.length === 0) return emptyIntent();
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
    if (actualPaths.length === 0)
      return emptyIntent([...files].map(([path, file]) => [path, file.fingerprint]));
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
    return saveIntent(
      {
        version: 1,
        scope: scopeRecord(state),
        commitSha,
        treeSha: tree,
        paths: actualPaths,
        files: [...files].map(([path, file]) => [path, file.fingerprint]),
      },
      scope,
    );
  });
}

/** Persist the prepared intent before this call. Retrying the same journalled
 * intent accepts its already-published ref, but never advances a different head. */
export function publishTaskCommit(intent: TaskCommitIntent): TaskCommitResult {
  const state = intents.get(intent);
  if (!state) throw new TaskCheckoutError("invalid_scope", "Unknown checkpoint intent.");
  const { stored } = state;
  const { checkout, foreign, ref, previousRef, contextPaths } = validateStoredScope(
    stored.scope,
    stored.scope.checkout,
  );
  const root = checkout.worktreePath;
  for (const [path, fingerprint] of foreign) {
    if (foreignFingerprint(root, path) !== fingerprint)
      throw new TaskCheckoutError(
        "scope_overlap",
        `Pre-existing changes differ from the saved scope: ${path}`,
      );
  }
  const owned = dirtyPaths(root).filter(
    (path) => !foreign.has(path) && !contextPaths.includes(path),
  );
  if (owned.some((path) => !stored.files.some(([file]) => file === path))) {
    throw new TaskCheckoutError(
      "scope_changed",
      "New task changes appeared after checkpoint preparation.",
    );
  }
  for (const [path, fingerprint] of stored.files) {
    if (fileState(root, path).fingerprint !== fingerprint)
      throw new TaskCheckoutError(
        "scope_changed",
        `Task changes differ from the prepared checkpoint: ${path}`,
      );
  }
  const current = currentRef(checkout, ref);
  if (stored.commitSha === null) {
    if (current !== previousRef)
      throw new TaskCheckoutError(
        "checkpoint_conflict",
        "The task ref advanced during an empty checkpoint.",
      );
    return { status: "no_changes", commitSha: null, paths: [] };
  }
  const parents = taskGit(root, ["rev-list", "--parents", "-n", "1", stored.commitSha])
    .output.toString()
    .trim()
    .split(" ");
  const tree = taskGit(root, ["rev-parse", `${stored.commitSha}^{tree}`])
    .output.toString()
    .trim();
  const actualPaths = nulPaths(
    taskGit(root, [
      "diff-tree",
      "--no-commit-id",
      "--no-renames",
      "--name-only",
      "-r",
      "-z",
      checkout.snapshotCommit,
      stored.commitSha,
      "--",
    ]).output,
  ).sort();
  if (
    parents.length !== 2 ||
    parents[1] !== checkout.snapshotCommit ||
    tree !== stored.treeSha ||
    JSON.stringify(actualPaths) !== JSON.stringify(stored.paths)
  ) {
    throw new TaskCheckoutError(
      "invalid_scope",
      "The saved checkpoint does not match its parent, tree or whitelist.",
    );
  }
  if (current !== stored.commitSha) {
    if (current !== previousRef)
      throw new TaskCheckoutError(
        "checkpoint_conflict",
        "The checkpoint ref advanced to another commit.",
      );
    const published = taskGit(
      root,
      [
        "update-ref",
        "--no-deref",
        ref,
        stored.commitSha,
        previousRef ?? "0".repeat(checkout.snapshotCommit.length),
      ],
      { allowFailure: true },
    );
    if (published.status !== 0)
      throw new TaskCheckoutError(
        "checkpoint_conflict",
        "The checkpoint ref could not be advanced atomically.",
      );
  }
  if (state.sourceScope) scopes.delete(state.sourceScope);
  return {
    status: "committed",
    commitSha: stored.commitSha,
    parentSha: checkout.snapshotCommit,
    ref,
    paths: stored.paths,
  };
}

export function commitTaskChanges(scope: TaskChangeScope, message: string): TaskCommitResult {
  return publishTaskCommit(prepareTaskCommit(scope, message));
}
