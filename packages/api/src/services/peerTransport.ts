import { createServer, request as httpsRequest, type Server } from "node:https";
import { TLSSocket } from "node:tls";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { PeerError, peerAddressSchema } from "@aif/shared";
import { diagnosePeerError } from "./peerErrors.js";
import {
  acceptPeerInvitation,
  acknowledgePeerCheckpoint,
  acknowledgePeerWatermarks,
  applyPeerDelta,
  finishPeerCheckpoint,
  getLocalDevice,
  listSyncPeerProjects,
  offerPeerCheckpoint,
  peerDelta,
  preparePeerCheckpoint,
  readPeerCheckpoint,
  requireSyncPeer,
  stagePeerCheckpoint,
  updatePeerContact,
  resetPeerBootstrap,
} from "@aif/data";
import { certificateFingerprint, type PeerTlsIdentity } from "./peerIdentity.js";
import { peerEnvelopeSchema, type PeerRequest } from "./peerProtocol.js";

const MAX_BODY = 4_300_000;
async function readBody(message: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of message) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new PeerError("peer_quota_exceeded");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PeerError("peer_request_invalid");
  }
}
const versionSchema = z.object({ protocolVersion: z.literal(1), schemaVersion: z.literal(1) });
const responseSchema = z
  .object({
    protocolVersion: z.literal(1),
    schemaVersion: z.literal(1),
    deviceId: z.uuid(),
    result: z.unknown().optional(),
    error: z.string().max(100).optional(),
  })
  .strict();

/** Public CA/hostname trust is replaced by an explicit certificate pin, checked before any HTTP body is sent. */
export async function peerRequest(input: {
  address: string;
  fingerprint: string;
  deviceId: string;
  identity: PeerTlsIdentity;
  request: PeerRequest;
  signal?: AbortSignal;
}): Promise<unknown> {
  const url = new URL(peerAddressSchema.parse(input.address));
  const body = JSON.stringify({
    protocolVersion: 1,
    schemaVersion: 1,
    deviceId: input.identity.deviceId,
    request: input.request,
  });
  if (Buffer.byteLength(body) > MAX_BODY) throw new PeerError("peer_quota_exceeded");
  return new Promise((resolve, reject) => {
    let pinned = false;
    const request = httpsRequest(
      url,
      {
        method: "POST",
        path: "/sync",
        key: input.identity.key,
        cert: input.identity.cert,
        minVersion: "TLSv1.3",
        rejectUnauthorized: false,
        agent: false,
        signal: input.signal,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Connection: "close",
        },
      },
      (response) => {
        if (!pinned) {
          response.destroy();
          reject(new PeerError("peer_identity_mismatch"));
          return;
        }
        void readBody(response)
          .then((value) => {
            if (!versionSchema.safeParse(value).success) throw new PeerError("peer_incompatible");
            const parsed = responseSchema.safeParse(value);
            if (!parsed.success) throw new PeerError("peer_request_invalid");
            if (parsed.data.deviceId !== input.deviceId)
              throw new PeerError("peer_identity_mismatch");
            if (parsed.data.error) {
              // Keep remote structured diagnostics; never branch on arbitrary message text.
              const error = new PeerError(
                parsed.data.error === "peer_storage_full" ||
                  parsed.data.error === "peer_storage_unavailable"
                  ? parsed.data.error
                  : "peer_request_invalid",
              );
              throw Object.assign(error, { remoteCode: parsed.data.error });
            }
            if (response.statusCode !== 200) throw new PeerError("peer_request_invalid");
            resolve(parsed.data.result);
          })
          .catch(reject);
      },
    );
    request.setTimeout(15_000, () => request.destroy(new PeerError("peer_unavailable")));
    const deadline = setTimeout(() => request.destroy(new PeerError("peer_unavailable")), 20_000);
    request.on("close", () => clearTimeout(deadline));
    request.on("error", (error) =>
      reject(error instanceof PeerError ? error : new PeerError("peer_unavailable")),
    );
    request.on("socket", (socket) => {
      if (!(socket instanceof TLSSocket)) {
        request.destroy(new PeerError("peer_identity_mismatch"));
        return;
      }
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerCertificate();
        if (
          !certificate.raw ||
          certificateFingerprint(certificate.raw) !== input.fingerprint ||
          socket.getProtocol() !== "TLSv1.3"
        ) {
          request.destroy(new PeerError("peer_identity_mismatch"));
          return;
        }
        pinned = true;
        request.end(body);
      });
    });
  });
}

export function dispatchPeerRequest(peerId: string, request: PeerRequest, fingerprint: string) {
  const { deviceId, name } = getLocalDevice();
  if (request.kind === "pair") {
    if (request.identity.deviceId !== peerId) throw new PeerError("peer_identity_mismatch");
    const projectIds = acceptPeerInvitation(
      {
        ...request.identity,
        invitationId: request.invitationId,
        token: request.token,
        projectIds: request.projectIds,
      },
      fingerprint,
    );
    return { identity: { deviceId, name }, projectIds };
  }
  requireSyncPeer(peerId, fingerprint);
  switch (request.kind) {
    case "resync":
      resetPeerBootstrap(peerId, request.projectId);
      return { ok: true };
    case "hello":
      return {
        identity: { deviceId, name },
        projectIds: listSyncPeerProjects(peerId).map((row) => row.projectId),
      };
    case "checkpointRequest":
      return preparePeerCheckpoint(peerId, request.projectId);
    case "checkpointRead":
      return readPeerCheckpoint(peerId, request.projectId, request.checkpointId, request.from);
    case "checkpointOffer":
      return offerPeerCheckpoint(peerId, request.manifest);
    case "checkpointStage":
      return stagePeerCheckpoint(peerId, request.projectId, request.checkpointId, request.entries);
    case "checkpointFinish":
      return finishPeerCheckpoint(peerId, request.projectId, request.checkpointId);
    case "checkpointAck":
      acknowledgePeerCheckpoint(
        peerId,
        request.projectId,
        request.checkpointId,
        request.watermarks,
      );
      return { ok: true };
    case "exchange": {
      const applied = applyPeerDelta(peerId, request.projectId, request.operations);
      acknowledgePeerWatermarks(peerId, request.projectId, request.ack);
      return { ...applied, operations: peerDelta(peerId, request.projectId) };
    }
  }
}

export async function startPeerListener(input: {
  identity: PeerTlsIdentity;
  port: number;
  host?: string;
  onChange?: () => void;
}): Promise<Server> {
  let active = 0;
  let pairingWindow = 0;
  let pairingAttempts = 0;
  const server = createServer(
    {
      key: input.identity.key,
      cert: input.identity.cert,
      minVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: false,
      maxHeaderSize: 8192,
    },
    (request, response) => {
      const reply = (status: number, value: object) => {
        if (response.destroyed || response.headersSent) return;
        response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            schemaVersion: 1,
            deviceId: input.identity.deviceId,
            ...value,
          }),
        );
      };
      if (++active > 8) {
        active--;
        reply(429, { error: "peer_quota_exceeded" });
        return;
      }
      void (async () => {
        if (
          request.method !== "POST" ||
          request.url !== "/sync" ||
          !(request.socket instanceof TLSSocket)
        )
          throw new PeerError("peer_request_invalid");
        const certificate = request.socket.getPeerCertificate();
        if (!certificate.raw || request.socket.getProtocol() !== "TLSv1.3")
          throw new PeerError("peer_not_paired");
        const fingerprint = certificateFingerprint(certificate.raw);
        const raw = await readBody(request);
        if (!versionSchema.safeParse(raw).success) throw new PeerError("peer_incompatible");
        const parsed = peerEnvelopeSchema.safeParse(raw);
        if (!parsed.success) throw new PeerError("peer_request_invalid");
        if (parsed.data.request.kind === "pair") {
          const window = Math.floor(Date.now() / 60_000);
          if (window !== pairingWindow) {
            pairingWindow = window;
            pairingAttempts = 0;
          }
          if (++pairingAttempts > 30) throw new PeerError("peer_quota_exceeded");
        }
        const result = dispatchPeerRequest(parsed.data.deviceId, parsed.data.request, fingerprint);
        updatePeerContact(parsed.data.deviceId);
        reply(200, { result });
        if (
          parsed.data.request.kind === "checkpointFinish" ||
          (parsed.data.request.kind === "exchange" &&
            typeof result === "object" &&
            result &&
            "applied" in result &&
            typeof result.applied === "number" &&
            result.applied > 0)
        )
          input.onChange?.();
      })()
        .catch((error: unknown) => {
          reply(400, {
            error: diagnosePeerError(error).code,
          });
        })
        .finally(() => {
          active--;
        });
    },
  );
  server.maxConnections = 32;
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.setTimeout(20_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port, input.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
