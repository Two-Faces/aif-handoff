import { z } from "zod";

export const peerFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const peerAddressSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use an https://host:port origin");
export const peerIdentitySchema = z
  .object({ deviceId: z.uuid(), name: z.string().min(1).max(100) })
  .strict();
export const peerInvitationSchema = z
  .object({
    protocolVersion: z.literal(1),
    schemaVersion: z.literal(1),
    invitationId: z.uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    deviceId: z.uuid(),
    fingerprint: peerFingerprintSchema,
    projectIds: z.array(z.uuid()).min(1).max(50),
    expiresAt: z.number().int(),
  })
  .strict();
export type PeerInvitation = z.infer<typeof peerInvitationSchema>;
export class PeerError extends Error {
  constructor(
    readonly code:
      | "peer_not_paired"
      | "peer_revoked"
      | "peer_identity_mismatch"
      | "peer_scope_denied"
      | "pairing_expired"
      | "pairing_invalid"
      | "pairing_used"
      | "peer_incompatible"
      | "peer_request_invalid"
      | "peer_quota_exceeded"
      | "peer_unavailable"
      | "peer_not_enabled"
      | "peer_checkpoint_mismatch"
      | "peer_storage_full"
      | "peer_storage_unavailable",
  ) {
    super(code);
    this.name = "PeerError";
  }
}
