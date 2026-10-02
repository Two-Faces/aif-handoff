import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../sync/causality.js";
import {
  assertTaskCheckout,
  assertTaskFileAttributes,
  taskGit,
  taskGitText,
  type TaskCheckoutInput,
} from "../taskCheckout.js";
import {
  codeSnapshotPackageSchema,
  contextManifestSchema,
  isPortableContextPath,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_FILES,
  type CodeSnapshotPackage,
  type CodeSnapshotDescriptor,
  type ContextManifest,
  type ContinuationNotes,
} from "./contracts.js";

export class CodeSnapshotError extends Error {
  constructor(
    readonly code:
      | "invalid_package"
      | "invalid_context_path"
      | "context_changed"
      | "context_collision"
      | "missing_blob"
      | "missing_code"
      | "snapshot_conflict",
    message: string,
  ) {
    super(message);
    this.name = "CodeSnapshotError";
  }
}
export function snapshotDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function contextBlobDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Conservative portable subset of Codex role TOML. Local MCP, auth, commands
 * and permission escalation are not transported as agent configuration. */
function validateRoleDefinition(path: string, bytes: Buffer): void {
  if (!path.startsWith(".codex/agents/") || !path.endsWith(".toml")) return;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new CodeSnapshotError("invalid_context_path", "Agent definitions must be UTF-8");
  const keys = new Set<string>();
  let delimiter: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (delimiter) {
      const end = line.indexOf(delimiter);
      if (end < 0) continue;
      if (!/^\s*(?:#.*)?$/.test(line.slice(end + 3)))
        throw new CodeSnapshotError("invalid_context_path", "Unsupported agent definition syntax");
      delimiter = null;
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const entry = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (
      !entry ||
      keys.has(entry[1]) ||
      ![
        "name",
        "description",
        "model",
        "model_reasoning_effort",
        "developer_instructions",
        "sandbox_mode",
      ].includes(entry[1])
    )
      throw new CodeSnapshotError(
        "invalid_context_path",
        "Agent definition contains local or unsupported configuration",
      );
    keys.add(entry[1]);
    const value = entry[2];
    if (
      entry[1] === "sandbox_mode" &&
      !/^(?:"(?:read-only|workspace-write)"|'(?:read-only|workspace-write)')\s*(?:#.*)?$/.test(
        value,
      )
    )
      throw new CodeSnapshotError(
        "invalid_context_path",
        "Agent definition requests unsupported permissions",
      );
    const quote = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (quote) {
      if (!["developer_instructions", "description"].includes(entry[1]))
        throw new CodeSnapshotError("invalid_context_path", "Unsupported multiline agent setting");
      const end = value.indexOf(quote, 3);
      if (end < 0) delimiter = quote;
      else if (!/^\s*(?:#.*)?$/.test(value.slice(end + 3)))
        throw new CodeSnapshotError("invalid_context_path", "Unsupported agent definition syntax");
    } else if (!/^(?:"[^"\r\n]*"|'[^'\r\n]*')\s*(?:#.*)?$/.test(value))
      throw new CodeSnapshotError(
        "invalid_context_path",
        "Portable agent settings must be simple strings",
      );
  }
  if (delimiter)
    throw new CodeSnapshotError("invalid_context_path", "Unterminated agent definition string");
}

function safeFile(root: string, path: string, allowMissing = false): string {
  if (!isPortableContextPath(path))
    throw new CodeSnapshotError("invalid_context_path", `Context path is not allowed: ${path}`);
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink())
        throw new CodeSnapshotError(
          "invalid_context_path",
          `Context symlink/junction is not allowed: ${path}`,
        );
      if (current === join(root, path) && (!stat.isFile() || stat.size > MAX_CONTEXT_FILE_BYTES))
        throw new CodeSnapshotError("invalid_context_path", `Invalid context file: ${path}`);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return current;
}

function treeFiles(root: string, commit: string) {
  const bytes = taskGit(root, ["ls-tree", "-rz", commit]).output;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new CodeSnapshotError("invalid_context_path", "Git paths must be UTF-8");
  return text
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, oid] = line.slice(0, tab).split(" ");
      return { mode, type, oid, path: line.slice(tab + 1) };
    });
}

/** Read tracked context from immutable Git blobs, portable files only from an
 * explicit allowlist in the task checkout. No user-home directories or configs. */
export function captureContextManifest(input: {
  checkout: TaskCheckoutInput;
  commitSha: string;
  notes: ContinuationNotes;
  planText: string | null;
  portablePaths?: string[];
}): { context: ContextManifest; blobs: CodeSnapshotPackage["blobs"] } {
  assertTaskCheckout(input.checkout);
  const files: ContextManifest["files"] = [];
  const blobs = new Map<string, string>();
  let total = 0;
  const add = (path: string, source: "git" | "portable", bytes: Buffer, gitBlob: string | null) => {
    if (files.length >= MAX_CONTEXT_FILES)
      throw new CodeSnapshotError("invalid_package", "Too many context files");
    validateRoleDefinition(path, bytes);
    total += bytes.length;
    if (bytes.length > MAX_CONTEXT_FILE_BYTES || total > MAX_CONTEXT_BYTES)
      throw new CodeSnapshotError("invalid_package", "Context exceeds the package size limit");
    const digest = contextBlobDigest(bytes);
    files.push({ path, source, digest, size: bytes.length, gitBlob });
    blobs.set(digest, bytes.toString("base64"));
  };
  const tree = treeFiles(input.checkout.worktreePath, input.commitSha);
  for (const file of tree) {
    if (!isPortableContextPath(file.path)) continue;
    if (file.type !== "blob" || file.mode === "120000")
      throw new CodeSnapshotError(
        "invalid_context_path",
        `Unsupported context entry: ${file.path}`,
      );
    const size = Number(taskGitText(input.checkout.worktreePath, ["cat-file", "-s", file.oid]));
    if (size > MAX_CONTEXT_FILE_BYTES)
      throw new CodeSnapshotError("invalid_package", "Tracked context file is too large");
    add(
      file.path,
      "git",
      taskGit(input.checkout.worktreePath, ["cat-file", "blob", file.oid]).output,
      file.oid,
    );
  }
  for (const path of [...new Set(input.portablePaths ?? [])].sort()) {
    if (!isPortableContextPath(path))
      throw new CodeSnapshotError("invalid_context_path", `Context path is not allowed: ${path}`);
    if (tree.some((file) => file.path === path)) continue;
    const file = safeFile(input.checkout.worktreePath, path);
    add(path, "portable", readFileSync(file), null);
  }
  const parsed = contextManifestSchema.safeParse({
    version: 1,
    projectId: input.checkout.projectId,
    taskId: input.checkout.taskId,
    commitSha: input.commitSha,
    notes: input.notes,
    plan: { text: input.planText, revision: snapshotDigest({ text: input.planText }) },
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
  if (!parsed.success)
    throw new CodeSnapshotError("invalid_package", "Invalid or incomplete continuation manifest");
  const context = parsed.data;
  return {
    context,
    blobs: [...blobs]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([digest, base64]) => ({ digest, base64 })),
  };
}

/** Validates received metadata and every blob; successful schema parsing alone
 * does not make a code/context package ready. No commands in notes are executed. */
export function verifyCodeSnapshotPackage(value: unknown): CodeSnapshotPackage {
  const parsed = codeSnapshotPackageSchema.safeParse(value);
  if (!parsed.success)
    throw new CodeSnapshotError("invalid_package", "Invalid code/context snapshot contract");
  const pack = parsed.data;
  if (Buffer.byteLength(canonicalJson(pack.context)) > 1_048_576)
    throw new CodeSnapshotError("invalid_package", "Context metadata is too large");
  if (
    pack.id !== snapshotDigest(pack.descriptor) ||
    pack.descriptor.contextDigest !== snapshotDigest(pack.context) ||
    pack.context.projectId !== pack.descriptor.projectId ||
    pack.context.taskId !== pack.descriptor.taskId ||
    pack.context.commitSha !== pack.descriptor.commitSha ||
    pack.context.plan.revision !== snapshotDigest({ text: pack.context.plan.text })
  )
    throw new CodeSnapshotError(
      "invalid_package",
      "Snapshot identity or context binding does not match",
    );
  if (
    pack.blobs.reduce((sum, blob) => sum + blob.base64.length, 0) >
    Math.ceil(MAX_CONTEXT_BYTES / 3) * 4 + MAX_CONTEXT_FILE_BYTES
  )
    throw new CodeSnapshotError("invalid_package", "Context blob payload is too large");
  const blobs = new Map<string, Buffer>();
  for (const blob of pack.blobs) {
    const bytes = Buffer.from(blob.base64, "base64");
    if (
      bytes.toString("base64") !== blob.base64 ||
      bytes.length > MAX_CONTEXT_FILE_BYTES ||
      contextBlobDigest(bytes) !== blob.digest ||
      blobs.has(blob.digest)
    )
      throw new CodeSnapshotError("invalid_package", "Invalid or duplicated content blob");
    blobs.set(blob.digest, bytes);
  }
  const needed = new Set(pack.context.files.map((file) => file.digest));
  if ([...blobs.keys()].some((digest) => !needed.has(digest)))
    throw new CodeSnapshotError("invalid_package", "Snapshot contains unexpected blobs");
  for (const file of pack.context.files) {
    const bytes = blobs.get(file.digest);
    if (!bytes)
      throw new CodeSnapshotError("missing_blob", `Context blob is missing: ${file.path}`);
    if (bytes.length !== file.size)
      throw new CodeSnapshotError("invalid_package", `Context size differs: ${file.path}`);
    validateRoleDefinition(file.path, bytes);
  }
  return pack;
}

export function makeCodeSnapshotPackage(
  descriptor: CodeSnapshotDescriptor,
  context: ContextManifest,
  blobs: CodeSnapshotPackage["blobs"],
): CodeSnapshotPackage {
  return verifyCodeSnapshotPackage({ id: snapshotDigest(descriptor), descriptor, context, blobs });
}

export function captureCodeSnapshotPackage(
  input: Parameters<typeof captureContextManifest>[0] & {
    sourceDeviceId: string;
    parentSnapshotId?: string | null;
    branchLabel?: string | null;
  },
): CodeSnapshotPackage {
  const { context, blobs } = captureContextManifest(input);
  const format = taskGitText(input.checkout.worktreePath, ["rev-parse", "--show-object-format"]);
  if (format !== "sha1" && format !== "sha256")
    throw new CodeSnapshotError("missing_code", "Unsupported Git object format");
  return makeCodeSnapshotPackage(
    {
      version: 1,
      projectId: input.checkout.projectId,
      taskId: input.checkout.taskId,
      sourceDeviceId: input.sourceDeviceId,
      commitSha: input.commitSha,
      baseCommit: input.checkout.snapshotCommit,
      objectFormat: format,
      branchLabel: input.branchLabel ?? null,
      parentSnapshotId: input.parentSnapshotId ?? null,
      contextDigest: snapshotDigest(context),
    },
    context,
    blobs,
  );
}

/** Materialize only verified portable context into an exact task checkout. All
 * collisions are checked before writes; retries accept identical bytes only. */
export function installContextSnapshot(input: {
  checkout: TaskCheckoutInput;
  package: CodeSnapshotPackage;
  verifyOnly?: boolean;
}): void {
  const pack = verifyCodeSnapshotPackage(input.package);
  assertTaskCheckout(input.checkout);
  if (
    input.checkout.snapshotCommit !== pack.descriptor.commitSha ||
    input.checkout.projectId !== pack.descriptor.projectId ||
    input.checkout.taskId !== pack.descriptor.taskId
  )
    throw new CodeSnapshotError(
      "snapshot_conflict",
      "The context belongs to another task checkout",
    );
  const root = input.checkout.worktreePath;
  assertTaskFileAttributes(
    root,
    Buffer.from(pack.context.files.map((file) => `${file.path}\0`).join("")),
  );
  const tree = treeFiles(root, pack.descriptor.commitSha);
  const writes: { path: string; relativePath: string; bytes: Buffer }[] = [];
  for (const entry of pack.context.files) {
    const tracked = tree.find((file) => file.path === entry.path);
    if (entry.source === "git") {
      if (
        !tracked ||
        tracked.oid !== entry.gitBlob ||
        tracked.type !== "blob" ||
        tracked.mode === "120000"
      )
        throw new CodeSnapshotError(
          "context_changed",
          `Tracked context does not match the commit: ${entry.path}`,
        );
      if (
        contextBlobDigest(taskGit(root, ["cat-file", "blob", tracked.oid]).output) !== entry.digest
      )
        throw new CodeSnapshotError(
          "context_changed",
          `Tracked context digest differs: ${entry.path}`,
        );
      const path = safeFile(root, entry.path);
      const actual = taskGit(root, ["hash-object", `--path=${entry.path}`, "--stdin"], {
        input: readFileSync(path),
      })
        .output.toString()
        .trim();
      if (actual !== tracked.oid)
        throw new CodeSnapshotError(
          "context_collision",
          `Existing tracked context was edited: ${entry.path}`,
        );
      continue;
    }
    if (tracked)
      throw new CodeSnapshotError(
        "context_collision",
        `Portable context would replace tracked content: ${entry.path}`,
      );
    const path = safeFile(root, entry.path, true);
    const blob = pack.blobs.find((item) => item.digest === entry.digest);
    if (!blob) throw new CodeSnapshotError("missing_blob", entry.path);
    const bytes = Buffer.from(blob.base64, "base64");
    try {
      const existing = readFileSync(path);
      if (!existing.equals(bytes))
        throw new CodeSnapshotError(
          "context_collision",
          `Existing context was edited: ${entry.path}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (input.verifyOnly)
        throw new CodeSnapshotError("context_changed", `Context file is missing: ${entry.path}`);
      writes.push({ path, relativePath: entry.path, bytes });
    }
  }
  for (const write of writes) {
    mkdirSync(dirname(write.path), { recursive: true });
    safeFile(root, write.relativePath, true);
    const fd = openSync(write.path, "wx", 0o600);
    try {
      writeFileSync(fd, write.bytes);
    } finally {
      closeSync(fd);
    }
  }
}

export function codeSnapshotRef(id: string): string {
  if (!/^[0-9a-f]{64}$/.test(id))
    throw new CodeSnapshotError("invalid_package", "Invalid snapshot identifier");
  return `refs/aif/snapshots/${id}`;
}
export function pinCodeSnapshot(projectRoot: string, pack: CodeSnapshotPackage): void {
  verifyCodeSnapshotPackage(pack);
  const format = taskGitText(projectRoot, ["rev-parse", "--show-object-format"]);
  const actual = taskGitText(projectRoot, [
    "rev-parse",
    "--verify",
    `${pack.descriptor.commitSha}^{commit}`,
  ]);
  if (format !== pack.descriptor.objectFormat || actual !== pack.descriptor.commitSha)
    throw new CodeSnapshotError("missing_code", "Snapshot commit/object format is unavailable");
  const ref = codeSnapshotRef(pack.id);
  if (taskGit(projectRoot, ["symbolic-ref", "-q", ref], { allowFailure: true }).status === 0)
    throw new CodeSnapshotError("snapshot_conflict", "A snapshot ref cannot alias a branch");
  const old = taskGit(projectRoot, ["rev-parse", "--verify", "--quiet", ref], {
    allowFailure: true,
  });
  if (old.status === 0) {
    if (old.output.toString().trim() !== actual)
      throw new CodeSnapshotError(
        "snapshot_conflict",
        "Immutable snapshot ref already points elsewhere",
      );
    return;
  }
  if (
    old.status !== 1 ||
    taskGit(projectRoot, ["update-ref", "--no-deref", ref, actual, "0".repeat(actual.length)], {
      allowFailure: true,
    }).status !== 0
  )
    throw new CodeSnapshotError("snapshot_conflict", "Cannot pin the immutable snapshot ref");
}
