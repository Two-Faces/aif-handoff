import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isPortableSnapshotPath } from "./handoff/contracts.js";

export class TaskCheckoutError extends Error {
  constructor(
    readonly code:
      | "invalid_snapshot"
      | "invalid_path"
      | "path_collision"
      | "identity_mismatch"
      | "head_drift"
      | "unsupported_entry"
      | "git_failed"
      | "scope_overlap"
      | "scope_changed"
      | "invalid_scope"
      | "checkpoint_conflict",
    message: string,
  ) {
    super(message);
    this.name = "TaskCheckoutError";
  }
}

export interface TaskCheckoutInput {
  projectRoot: string;
  worktreePath: string;
  projectId: string;
  taskId: string;
  /** Full immutable object ID, never a branch label, tag or revision expression. */
  snapshotCommit: string;
}

const identitySchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    commonDir: z.string(),
    worktreePath: z.string(),
    snapshotCommit: z.string(),
  })
  .strict();

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Each command addresses its repository explicitly; inherited Git overrides
 * must not redirect writes into the user's index, worktree or object database. */
export function taskGit(
  root: string,
  args: string[],
  options: { input?: string | Buffer; indexFile?: string; allowFailure?: boolean } = {},
): { output: Buffer; status: number } {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_NO_LAZY_FETCH = "1";
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  try {
    const output = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgSign=false",
        ...args,
      ],
      {
        env,
        input: options.input,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return { output, status: 0 };
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    if (options.allowFailure) {
      return { output: failure.stdout ?? Buffer.alloc(0), status: failure.status ?? -1 };
    }
    throw new TaskCheckoutError(
      "git_failed",
      `Git ${args[0]} failed (${failure.status ?? "spawn"}): ${failure.stderr?.toString().trim() ?? "no diagnostics"}`,
    );
  }
}

export function taskGitText(root: string, args: string[]): string {
  return taskGit(root, args).output.toString("utf8").trim();
}

export function withTaskIndex<T>(root: string, run: (indexFile: string) => T): T {
  const gitDir = taskGitText(root, ["rev-parse", "--absolute-git-dir"]);
  const temporary = mkdtempSync(join(gitDir, "aif-checkpoint-"));
  const indexFile = join(temporary, "index");
  try {
    return run(indexFile);
  } finally {
    // Only these exact files in our exclusive directory may be removed.
    for (const file of [indexFile, `${indexFile}.lock`]) {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    rmdirSync(temporary);
  }
}

/** Inspect attributes without executing custom filters (including LFS). */
export function assertTaskFileAttributes(root: string, paths: Buffer, indexFile?: string): void {
  const args = ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"];
  if (indexFile) args.splice(1, 0, "--cached");
  const attributes = taskGit(root, args, { input: paths, indexFile })
    .output.toString("utf8")
    .split("\0");
  for (let i = 0; i + 2 < attributes.length; i += 3) {
    const [path, attribute, value] = attributes.slice(i, i + 3);
    if (value !== "unspecified" && value !== "unset") {
      throw new TaskCheckoutError(
        "unsupported_entry",
        `${path} uses ${attribute}=${value}; portable checkpoint support is required first.`,
      );
    }
  }
}

function canonical(path: string): string {
  return realpathSync.native(path);
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
}

function validateDestination(root: string, destination: string, commonDir: string): void {
  if (
    !isAbsolute(destination) ||
    contains(root, destination) ||
    contains(destination, root) ||
    contains(commonDir, destination)
  ) {
    throw new TaskCheckoutError(
      "invalid_path",
      "A task checkout must have a separate absolute path outside the source checkout and Git directory.",
    );
  }
  // Do not follow symlinks/junctions into a different managed location.
  let parent = destination;
  while (true) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new TaskCheckoutError(
        "invalid_path",
        `Task checkout path contains a symlink or junction: ${parent}`,
      );
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}

function commonDirectory(root: string): string {
  return canonical(resolve(root, taskGitText(root, ["rev-parse", "--git-common-dir"])));
}

function identityFile(worktreePath: string): string {
  const gitDir = taskGitText(worktreePath, ["rev-parse", "--absolute-git-dir"]);
  return join(gitDir, "aif-task-checkout.json");
}

function expectedIdentity(input: TaskCheckoutInput) {
  if (!input.projectId || !input.taskId || !OBJECT_ID.test(input.snapshotCommit)) {
    throw new TaskCheckoutError(
      "invalid_snapshot",
      "A task checkout requires project/task IDs and a full commit object ID.",
    );
  }
  const commit = taskGit(
    input.projectRoot,
    ["rev-parse", "--verify", `${input.snapshotCommit}^{commit}`],
    { allowFailure: true },
  );
  if (commit.status !== 0 || commit.output.toString().trim() !== input.snapshotCommit) {
    throw new TaskCheckoutError(
      "invalid_snapshot",
      "The requested immutable commit is not available in the local repository.",
    );
  }
  const root = canonical(input.projectRoot);
  if (canonical(taskGitText(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new TaskCheckoutError(
      "invalid_path",
      "The project binding must identify the repository root.",
    );
  }
  const commonDir = commonDirectory(root);
  const worktreePath = resolve(input.worktreePath);
  validateDestination(root, input.worktreePath, commonDir);
  const registered = taskGitText(root, ["worktree", "list", "--porcelain", "-z"]).split("\0");
  for (const entry of registered) {
    if (!entry.startsWith("worktree ")) continue;
    const other = resolve(entry.slice("worktree ".length));
    if (relative(other, worktreePath) === "") continue;
    if (contains(other, worktreePath) || contains(worktreePath, other)) {
      throw new TaskCheckoutError(
        "invalid_path",
        "A task checkout cannot overlap another registered worktree.",
      );
    }
  }
  return {
    version: 1 as const,
    projectId: input.projectId,
    taskId: input.taskId,
    commonDir,
    worktreePath,
    snapshotCommit: input.snapshotCommit,
  };
}

/** Verify every reuse, even when the branch label happens to be unchanged. */
export function assertTaskCheckout(input: TaskCheckoutInput): void {
  const expected = expectedIdentity(input);
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(identityFile(expected.worktreePath), "utf8"));
  } catch {
    throw new TaskCheckoutError(
      "identity_mismatch",
      "This directory is not a registered task checkout.",
    );
  }
  const parsed = identitySchema.safeParse(stored);
  if (
    !parsed.success ||
    Object.entries(expected).some(
      ([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value,
    ) ||
    commonDirectory(expected.worktreePath) !== expected.commonDir ||
    canonical(taskGitText(expected.worktreePath, ["rev-parse", "--show-toplevel"])) !==
      canonical(expected.worktreePath)
  ) {
    throw new TaskCheckoutError(
      "identity_mismatch",
      "The task checkout belongs to another task, repository or snapshot.",
    );
  }
  const branch = taskGit(expected.worktreePath, ["symbolic-ref", "-q", "HEAD"], {
    allowFailure: true,
  });
  if (
    branch.status !== 1 ||
    taskGitText(expected.worktreePath, ["rev-parse", "HEAD"]) !== expected.snapshotCommit
  ) {
    throw new TaskCheckoutError(
      "head_drift",
      "The task checkout HEAD changed. Prepare a new checkout from an explicitly accepted snapshot.",
    );
  }
}

/** Personal checkouts never fetch, pull, move a branch, or copy mutable context.
 * Ignored portable context is a separate immutable manifest (P11).
 */
export function prepareTaskCheckout(input: TaskCheckoutInput): {
  action: "created" | "reused";
  worktreePath: string;
  commitSha: string;
} {
  const expected = expectedIdentity(input);
  if (existsSync(expected.worktreePath)) {
    assertTaskCheckout(input);
    return {
      action: "reused",
      worktreePath: expected.worktreePath,
      commitSha: expected.snapshotCommit,
    };
  }
  const entries = taskGit(input.projectRoot, ["ls-tree", "-rz", expected.snapshotCommit])
    .output.toString("utf8")
    .split("\0");
  if (entries.some((entry) => entry.startsWith("120000 ") || entry.startsWith("160000 "))) {
    throw new TaskCheckoutError(
      "unsupported_entry",
      "Symlinks and submodules require explicit snapshot readiness support.",
    );
  }
  mkdirSync(dirname(expected.worktreePath), { recursive: true });
  withTaskIndex(input.projectRoot, (indexFile) => {
    taskGit(input.projectRoot, ["read-tree", expected.snapshotCommit], { indexFile });
    const paths = taskGit(input.projectRoot, ["ls-files", "-z"], { indexFile }).output;
    assertTaskFileAttributes(input.projectRoot, paths, indexFile);
  });
  // Exclusive reservation: never adopt an existing directory, even an empty one.
  try {
    mkdirSync(expected.worktreePath);
  } catch {
    throw new TaskCheckoutError(
      "path_collision",
      "The task checkout destination was created concurrently.",
    );
  }
  try {
    taskGit(input.projectRoot, [
      "worktree",
      "add",
      "--detach",
      "--",
      expected.worktreePath,
      expected.snapshotCommit,
    ]);
    writeFileSync(identityFile(expected.worktreePath), `${JSON.stringify(expected)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    assertTaskCheckout(input);
  } catch (error) {
    // Only remove our empty reservation. A partial checkout is retained for
    // diagnosis; never recursively delete files after an ambiguous Git failure.
    try {
      rmdirSync(expected.worktreePath);
    } catch {
      /* directory is not empty */
    }
    throw error;
  }
  return {
    action: "created",
    worktreePath: expected.worktreePath,
    commitSha: expected.snapshotCommit,
  };
}

export function taskCheckpointRef(input: Pick<TaskCheckoutInput, "projectId" | "taskId">): string {
  const key = createHash("sha256")
    .update(JSON.stringify([input.projectId, input.taskId]))
    .digest("hex");
  return `refs/aif/tasks/${key}/checkpoint`;
}

/** Host writes must remain inside their registered checkout, including when a
 * plan/config path is absolute or contains a symlink/junction. */
export function taskCheckoutFilePath(root: string, requested: string): string {
  const target = resolve(root, requested);
  const path = relative(root, target);
  if (!path || !contains(root, target) || !isPortableSnapshotPath(path.split(sep).join("/")))
    throw new TaskCheckoutError("invalid_path", "Task file path must stay inside the checkout");
  let cursor = root;
  for (const part of path.split(sep)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink())
        throw new TaskCheckoutError(
          "invalid_path",
          "Task file path contains a symlink or junction",
        );
      if (cursor === target && !stat.isFile())
        throw new TaskCheckoutError("invalid_path", "Task file path is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
