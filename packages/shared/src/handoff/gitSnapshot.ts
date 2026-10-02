import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertTaskCheckout,
  assertTaskFileAttributes,
  prepareTaskCheckout,
  taskGit,
  taskGitText,
  withTaskIndex,
  TaskCheckoutError,
  type TaskCheckoutInput,
} from "../taskCheckout.js";
import { isPortableSnapshotPath, type CodeSnapshotPackage } from "./contracts.js";
import {
  codeSnapshotRef,
  installContextSnapshot,
  pinCodeSnapshot,
  verifyCodeSnapshotPackage,
} from "./contextSnapshot.js";
import { MAX_BUNDLE_BYTES, SnapshotTransferError } from "./transferContracts.js";

function temporary<T>(root: string, run: (directory: string) => T): T {
  const common = realpathSync.native(
    resolve(root, taskGitText(root, ["rev-parse", "--git-common-dir"])),
  );
  const directory = mkdtempSync(join(common, "aif-transfer-"));
  try {
    return run(directory);
  } finally {
    // Only our exclusive generated directory is recursively removed.
    const suffix = relative(common, directory);
    if (!isAbsolute(suffix) && suffix.startsWith("aif-transfer-") && !suffix.includes(sep))
      rmSync(directory, { recursive: true, force: true });
  }
}
function requireRoot(root: string): void {
  if (
    realpathSync.native(root) !==
    realpathSync.native(taskGitText(root, ["rev-parse", "--show-toplevel"]))
  )
    throw new SnapshotTransferError("snapshot_binding_missing");
}
export function snapshotObjectFormat(root: string): string {
  requireRoot(root);
  return taskGitText(root, ["rev-parse", "--show-object-format"]);
}
export function hasSnapshotCommit(root: string, commit: string): boolean {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return false;
  const result = taskGit(root, ["rev-parse", "--verify", `${commit}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 && result.output.toString().trim() === commit;
}

/** No checkout, hooks, filters, submodule update or LFS fetch is used for readiness. */
export function assertPortableGitSnapshot(root: string, commit: string): void {
  const bytes = taskGit(root, ["ls-tree", "-rz", commit]).output;
  const tree = bytes.toString("utf8");
  if (!Buffer.from(tree).equals(bytes))
    throw new SnapshotTransferError("snapshot_unsupported_code");
  const paths = new Map<string, string>();
  for (const line of tree.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const [mode, kind] = line.slice(0, tab).split(" ");
    const path = line.slice(tab + 1);
    if (!["100644", "100755"].includes(mode) || kind !== "blob" || !isPortableSnapshotPath(path))
      throw new SnapshotTransferError("snapshot_unsupported_code");
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix.toLowerCase();
      if (paths.has(key) && paths.get(key) !== prefix)
        throw new SnapshotTransferError("snapshot_unsupported_code");
      paths.set(key, prefix);
    }
  }
  try {
    withTaskIndex(root, (indexFile) => {
      taskGit(root, ["read-tree", commit], { indexFile });
      assertTaskFileAttributes(
        root,
        taskGit(root, ["ls-files", "-z"], { indexFile }).output,
        indexFile,
      );
    });
  } catch (error) {
    if (error instanceof TaskCheckoutError && error.code === "unsupported_entry")
      throw new SnapshotTransferError("snapshot_unsupported_code");
    throw error;
  }
}

/** Strictly bounded, single-ref bundle v2/v3; object filters and extra refs are rejected. */
function verifyBundleHeader(
  bytes: Buffer,
  pack: CodeSnapshotPackage,
  baseCommit: string | null,
): void {
  const end = bytes.indexOf("\n\n");
  if (
    bytes.length > MAX_BUNDLE_BYTES ||
    end < 0 ||
    end > 16_384 ||
    bytes.subarray(end + 2, end + 6).toString() !== "PACK"
  )
    throw new SnapshotTransferError("snapshot_invalid");
  const lines = bytes.subarray(0, end).toString("utf8").split("\n");
  const version = lines.shift();
  if (version !== "# v2 git bundle" && version !== "# v3 git bundle")
    throw new SnapshotTransferError("snapshot_invalid");
  const capabilities = lines.filter((line) => line.startsWith("@"));
  if (
    (version === "# v2 git bundle" &&
      (pack.descriptor.objectFormat !== "sha1" || capabilities.length > 0)) ||
    (version === "# v3 git bundle" &&
      (capabilities.length !== 1 ||
        capabilities[0] !== `@object-format=${pack.descriptor.objectFormat}`))
  )
    throw new SnapshotTransferError("snapshot_format_mismatch");
  const prerequisites = lines.filter((line) => line.startsWith("-"));
  if (
    prerequisites.length !== (baseCommit ? 1 : 0) ||
    (baseCommit && prerequisites[0].split(" ")[0] !== `-${baseCommit}`)
  )
    throw new SnapshotTransferError("snapshot_invalid");
  const heads = lines.filter((line) => !line.startsWith("@") && !line.startsWith("-"));
  if (heads.length !== 1 || heads[0] !== `${pack.descriptor.commitSha} ${codeSnapshotRef(pack.id)}`)
    throw new SnapshotTransferError("snapshot_invalid");
}

export function createSnapshotBundle(
  root: string,
  value: CodeSnapshotPackage,
  incremental = false,
): Buffer {
  const pack = verifyCodeSnapshotPackage(value);
  requireRoot(root);
  pinCodeSnapshot(root, pack);
  assertPortableGitSnapshot(root, pack.descriptor.commitSha);
  const base = incremental ? pack.descriptor.baseCommit : null;
  if (
    base &&
    (base === pack.descriptor.commitSha ||
      taskGit(root, ["merge-base", "--is-ancestor", base, pack.descriptor.commitSha], {
        allowFailure: true,
      }).status !== 0)
  )
    throw new SnapshotTransferError("snapshot_base_missing");
  return temporary(root, (directory) => {
    const path = join(directory, "snapshot.bundle");
    taskGit(root, [
      "bundle",
      "create",
      "--version=3",
      path,
      codeSnapshotRef(pack.id),
      ...(base ? [`^${base}`] : []),
    ]);
    if (statSync(path).size > MAX_BUNDLE_BYTES) throw new SnapshotTransferError("snapshot_quota");
    const bytes = readFileSync(path);
    verifyBundleHeader(bytes, pack, base);
    return bytes;
  });
}

/** Validate in an isolated object database before importing any received object.
 * The only persistent ref published is the immutable snapshot namespace. */
export function importSnapshotBundle(
  root: string,
  value: CodeSnapshotPackage,
  bytes: Buffer,
  baseCommit: string | null,
): void {
  const pack = verifyCodeSnapshotPackage(value);
  if (snapshotObjectFormat(root) !== pack.descriptor.objectFormat)
    throw new SnapshotTransferError("snapshot_format_mismatch");
  if (baseCommit !== null && baseCommit !== pack.descriptor.baseCommit)
    throw new SnapshotTransferError("snapshot_invalid");
  verifyBundleHeader(bytes, pack, baseCommit);
  if (
    baseCommit &&
    taskGit(root, ["rev-list", "--objects", "--missing=error", baseCommit, "--"], {
      allowFailure: true,
    }).status !== 0
  )
    throw new SnapshotTransferError("snapshot_base_missing");
  temporary(root, (directory) => {
    const path = join(directory, "snapshot.bundle");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    if (taskGit(root, ["bundle", "verify", path], { allowFailure: true }).status !== 0)
      throw new SnapshotTransferError(baseCommit ? "snapshot_base_missing" : "snapshot_invalid");
    const quarantine = join(directory, "quarantine.git");
    mkdirSync(quarantine);
    taskGit(quarantine, [
      "init",
      "--bare",
      "--template=",
      `--object-format=${pack.descriptor.objectFormat}`,
    ]);
    if (baseCommit) {
      const objects = realpathSync.native(
        resolve(root, taskGitText(root, ["rev-parse", "--git-path", "objects"])),
      );
      if (/[\r\n]/.test(objects)) throw new SnapshotTransferError("snapshot_binding_missing");
      writeFileSync(
        join(quarantine, "objects", "info", "alternates"),
        `${objects.replaceAll("\\", "/")}\n`,
        { flag: "wx" },
      );
    }
    try {
      taskGit(quarantine, ["bundle", "unbundle", path]);
      taskGit(quarantine, [
        "fsck",
        "--strict",
        "--no-reflogs",
        "--no-dangling",
        pack.descriptor.commitSha,
      ]);
    } catch {
      throw new SnapshotTransferError("snapshot_invalid");
    }
    assertPortableGitSnapshot(quarantine, pack.descriptor.commitSha);
    // Unbundle stores objects only; unlike fetch it cannot update origin/*,
    // FETCH_HEAD, a user branch or the worktree/index.
    taskGit(root, ["bundle", "unbundle", path]);
    pinCodeSnapshot(root, pack);
  });
}

export function prepareReceivedSnapshot(
  checkout: TaskCheckoutInput,
  pack: CodeSnapshotPackage,
): void {
  assertPortableGitSnapshot(checkout.projectRoot, checkout.snapshotCommit);
  prepareTaskCheckout(checkout);
  verifyReceivedCodeCheckout(checkout, pack);
  installContextSnapshot({ checkout, package: pack });
  verifyReceivedSnapshot(checkout, pack);
}
function verifyReceivedCodeCheckout(checkout: TaskCheckoutInput, pack: CodeSnapshotPackage): void {
  assertTaskCheckout(checkout);
  const root = checkout.worktreePath;
  assertTaskFileAttributes(
    root,
    taskGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).output,
  );
  if (
    taskGit(root, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--"], {
      allowFailure: true,
    }).status !== 0 ||
    taskGit(root, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "--"], {
      allowFailure: true,
    }).status !== 0
  )
    throw new SnapshotTransferError("snapshot_checkout_changed");
  const portable = new Set(
    pack.context.files.filter((file) => file.source === "portable").map((file) => file.path),
  );
  const untracked = taskGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .output.toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (untracked.some((path) => !portable.has(path)))
    throw new SnapshotTransferError("snapshot_checkout_changed");
}
export function verifyReceivedSnapshot(
  checkout: TaskCheckoutInput,
  pack: CodeSnapshotPackage,
): void {
  verifyReceivedCodeCheckout(checkout, pack);
  // Verify without filling in deleted files or overwriting edits on a reused root.
  installContextSnapshot({ checkout, package: pack, verifyOnly: true });
}
