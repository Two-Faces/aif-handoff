import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  beginTaskChangeScope,
  captureCodeSnapshotPackage,
  commitTaskChanges,
  continuationNotesSchema,
  prepareTaskCheckout,
} from "@aif/shared";
import {
  bindProjectCheckout,
  createProject,
  createTask,
  findTaskById,
  getLocalDevice,
  getSnapshotTransfer,
  listSnapshotTransfers,
  loadCodeSnapshotPackage,
  recordLocalCodeSnapshot,
  storeCodeSnapshotPackage,
} from "@aif/data";
import type { PeerSyncService } from "../../services/peerSync.js";

const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function init(root: string, content: string) {
  mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Snapshot fixture");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", join(root, "no-hooks"));
  writeFileSync(join(root, "code.txt"), content);
  writeFileSync(join(root, ".gitignore"), ".ai-factory/\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture base");
}
const savedSchema = z.object({ projectId: z.string(), taskId: z.string(), snapshotId: z.string() });
export async function snapshotNodeAction(
  action: string,
  args: Record<string, unknown>,
  service: PeerSyncService,
  directory: string,
): Promise<unknown> {
  const root = realpathSync.native(directory);
  const source = join(root, "source");
  const savedPath = join(root, "snapshot.json");
  if (action === "code:seed" || action === "code:advance") {
    let ids: z.infer<typeof savedSchema>;
    if (action === "code:seed") {
      init(source, "source base\n");
      const project = createProject({
        name: "Snapshot fixture",
        rootPath: source,
        personalMode: true,
      })!;
      const task = createTask({
        projectId: project.id,
        title: "Snapshot transfer",
        description: "",
        paused: true,
        autoMode: false,
      })!;
      ids = { projectId: project.id, taskId: task.id, snapshotId: "" };
    } else ids = savedSchema.parse(JSON.parse(readFileSync(savedPath, "utf8")));
    const previous = ids.snapshotId ? loadCodeSnapshotPackage(ids.snapshotId, ids.projectId) : null;
    const input = {
      projectRoot: source,
      projectId: ids.projectId,
      taskId: ids.taskId,
      worktreePath: join(root, `task-${crypto.randomUUID()}`),
      snapshotCommit: previous?.descriptor.commitSha ?? git(source, "rev-parse", "HEAD"),
    };
    prepareTaskCheckout(input);
    const scope = beginTaskChangeScope(input);
    writeFileSync(join(input.worktreePath, "code.txt"), `${action}\n`);
    writeFileSync(join(input.worktreePath, "binary.bin"), randomBytes(600_000));
    const result = commitTaskChanges(scope, "fixture snapshot");
    if (result.status !== "committed") throw new Error("Missing fixture commit");
    mkdirSync(join(input.worktreePath, ".ai-factory"));
    writeFileSync(join(input.worktreePath, ".ai-factory", "CONTEXT.md"), randomBytes(300_000));
    const pack = captureCodeSnapshotPackage({
      checkout: input,
      commitSha: result.commitSha,
      sourceDeviceId: getLocalDevice().deviceId,
      parentSnapshotId: previous?.id,
      planText: null,
      notes: continuationNotesSchema.parse({ goal: "Transfer code", nextStep: "Native test" }),
      portablePaths: [".ai-factory/CONTEXT.md"],
    });
    storeCodeSnapshotPackage(pack);
    recordLocalCodeSnapshot(ids.projectId, pack.id, source);
    ids.snapshotId = pack.id;
    writeFileSync(savedPath, JSON.stringify(ids));
    return { ...ids, manifest: service.snapshots.publish(ids.projectId, pack.id) };
  }
  if (action === "code:bind") {
    const target = join(root, "target");
    if (!existsSync(target)) init(target, "independent target branch\n");
    writeFileSync(join(target, "code.txt"), "user staged\n");
    git(target, "add", "code.txt");
    writeFileSync(join(target, "code.txt"), "user unstaged\n");
    writeFileSync(join(target, "untracked.txt"), "user file\n");
    return bindProjectCheckout({
      projectId: z.string().parse(args.projectId),
      localRoot: target,
      executionEnvironment:
        process.platform === "win32"
          ? "native_windows"
          : process.platform === "darwin"
            ? "native_macos"
            : "native_linux",
      head: git(target, "rev-parse", "HEAD"),
      branch: "main",
    });
  }
  if (action === "code:pull")
    return service.snapshots.pull({
      peerId: z.string().parse(args.peerId),
      projectId: z.string().parse(args.projectId),
      snapshotId: z.string().parse(args.snapshotId),
      checkoutId: z.string().parse(args.checkoutId),
      worktreePath: join(
        root,
        z
          .string()
          .regex(/^received-[a-z0-9]+$/)
          .parse(args.name),
      ),
    });
  if (action === "code:list") return listSnapshotTransfers(z.string().parse(args.projectId));
  if (action === "code:status") return service.snapshots.status(z.string().parse(args.id));
  if (action === "code:report") {
    const row = getSnapshotTransfer(z.string().parse(args.id));
    return {
      progress: service.snapshots.status(row.id),
      completed: row.completed,
      selectedBundleDigest: row.selectedBundleDigest,
      head: git(row.worktreePath, "rev-parse", "HEAD"),
      code: readFileSync(join(row.worktreePath, "code.txt"), "utf8"),
      task: findTaskById(row.manifest.descriptor.taskId),
      root: row.worktreePath,
    };
  }
  if (action === "code:edit-context") {
    const row = getSnapshotTransfer(z.string().parse(args.id));
    unlinkSync(join(row.worktreePath, ".ai-factory", "CONTEXT.md"));
    return null;
  }
  if (action === "code:target-state") {
    const target = join(root, "target");
    return {
      head: git(target, "rev-parse", "HEAD"),
      refs: git(
        target,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes",
      ),
      index: readFileSync(join(target, ".git", "index")).toString("base64"),
      status: git(target, "status", "--porcelain=v1"),
      code: readFileSync(join(target, "code.txt"), "utf8"),
    };
  }
  if (action === "code:publish")
    return service.snapshots.publish(
      z.string().parse(args.projectId),
      z.string().parse(args.snapshotId),
    );
  if (action === "code:base-object") {
    const saved = savedSchema.parse(JSON.parse(readFileSync(savedPath, "utf8")));
    const pack = loadCodeSnapshotPackage(
      z.string().parse(args.snapshotId ?? saved.snapshotId),
      saved.projectId,
    );
    return {
      sha: pack.descriptor.baseCommit,
      commit: git(source, "cat-file", "commit", pack.descriptor.baseCommit) + "\n",
    };
  }
  if (action === "code:incomplete-base") {
    return execFileSync(
      "git",
      ["-C", join(root, "target"), "hash-object", "-w", "-t", "commit", "--stdin"],
      { input: z.string().parse(args.commit), encoding: "utf8", windowsHide: true },
    ).trim();
  }
  if (action === "code:remove") {
    service.snapshots.remove(z.string().parse(args.id));
    return null;
  }
  throw new Error(`Unknown code fixture action: ${action}`);
}
