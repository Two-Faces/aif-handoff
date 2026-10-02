import { z } from "zod";
import { PeerError, peerInvitationSchema } from "@aif/shared";
import {
  createProject,
  createTask,
  updateTask,
  deleteTask,
  listTasks,
  listProjects,
  getLocalDevice,
  getEntitySyncRevisions,
  toTaskResponse,
  listSyncConflicts,
  resolveSyncConflict,
  setSyncPeerAddress,
  acquireLocalDeviceLock,
  revokeSyncPeer,
} from "@aif/data";
import { readDeviceInstallationId } from "../../services/deviceInstallation.js";
import { loadPeerIdentity } from "../../services/peerIdentity.js";
import { createPeerSyncService } from "../../services/peerSync.js";
import { peerRequest } from "../../services/peerTransport.js";

const root = process.env.PEER_FIXTURE_DIRECTORY!;
const release = acquireLocalDeviceLock(readDeviceInstallationId(root), "Fixture");
const identity = loadPeerIdentity(getLocalDevice().deviceId, root);
let drop: string | null = null;
const service = createPeerSyncService(
  identity,
  () => {},
  async (input) => {
    const result = await peerRequest(input);
    if (input.request.kind === drop) {
      drop = null;
      throw new PeerError("peer_unavailable");
    }
    return result;
  },
);
const server = await service.start(0, "127.0.0.1", false);
const address = server.address();
if (!address || typeof address === "string") throw new Error("No listener");
process.send?.({
  ready: true,
  identity: service.identity(),
  address: `https://127.0.0.1:${address.port}`,
});

const commandSchema = z.object({
  id: z.number(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()),
});
process.on("message", (raw) => {
  void (async () => {
    const { id, action, args } = commandSchema.parse(raw);
    try {
      let result: unknown = null;
      if (action === "seed") {
        const project = createProject({
          name: "Shared fixture",
          rootPath: root,
          personalMode: true,
        })!;
        const count = z.number().int().min(1).max(200).parse(args.count);
        const tasks = Array.from(
          { length: count },
          (_, index) =>
            createTask({ projectId: project.id, title: `Task ${index}`, description: "Seed" })!,
        );
        result = { projectId: project.id, taskId: tasks[0]!.id };
      } else if (action === "invite")
        result = service.invitation(
          z.string().parse(args.fingerprint),
          z.array(z.string()).parse(args.projectIds),
        );
      else if (action === "pair")
        result = await service.pair(
          z.string().parse(args.address),
          peerInvitationSchema.parse(args.invitation),
          z.array(z.string()).parse(args.projectIds),
        );
      else if (action === "address")
        setSyncPeerAddress(z.string().parse(args.peerId), z.string().parse(args.address));
      else if (action === "sync") await service.sync(z.string().parse(args.peerId));
      else if (action === "drop") drop = z.string().parse(args.kind);
      else if (action === "edit") {
        const taskId = z.string().parse(args.taskId),
          projectId = z.string().parse(args.projectId);
        const patch = z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            plan: z.string().optional(),
          })
          .strict()
          .parse(args.patch);
        result = updateTask(taskId, patch, {
          expected: getEntitySyncRevisions(projectId, "task", taskId),
        });
      } else if (action === "delete") deleteTask(z.string().parse(args.taskId));
      else if (action === "snapshot")
        result = {
          projects: listProjects(),
          tasks: listTasks(z.string().parse(args.projectId)).map((task) => toTaskResponse(task)),
          conflicts: listSyncConflicts(z.string().parse(args.projectId)),
        };
      else if (action === "resolve") {
        const projectId = z.string().parse(args.projectId);
        const conflict = listSyncConflicts(projectId).find((item) => item.field === "plan")!;
        resolveSyncConflict({
          projectId,
          entityType: "task",
          entityId: conflict.entityId,
          field: "plan",
          value: "Resolved",
          parents: conflict.versions.map((item) => item.dot),
          actor: { kind: "anonymous", id: null, displayNameSnapshot: null },
        });
      } else if (action === "revoke") revokeSyncPeer(z.string().parse(args.peerId));
      else if (action === "stop") {
        await service.stop();
        release();
      } else throw new Error("Unknown fixture action");
      process.send?.({ id, result });
      if (action === "stop") process.disconnect?.();
    } catch (error) {
      process.send?.({
        id,
        error: error && typeof error === "object" && "code" in error ? error.code : String(error),
      });
    }
  })();
});
