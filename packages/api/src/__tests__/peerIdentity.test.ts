import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { certificateFingerprint, generatePeerIdentity } from "../services/peerIdentity.js";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

afterEach(() => vi.mocked(randomBytes).mockClear());

describe("peer certificate serial encoding", () => {
  it.each([
    [0x00, 0x00],
    [0x80, 0x00],
    [0x00, 0x7f],
    [0x00, 0x80],
    [0xff, 0xff],
  ])("generates a valid TLS identity with random prefix [%i, %i]", (first, second) => {
    const serial = Buffer.alloc(16);
    serial[0] = first!;
    serial[1] = second!;
    vi.mocked(randomBytes).mockImplementationOnce(() => serial);

    const identity = generatePeerIdentity(randomUUID());
    const certificate = new X509Certificate(identity.cert);
    expect(BigInt(`0x${certificate.serialNumber}`)).toBeGreaterThan(0n);
    expect(certificate.checkPrivateKey(createPrivateKey(identity.key))).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificateFingerprint(certificate.raw)).toBe(identity.fingerprint);
    expect(() => createSecureContext({ key: identity.key, cert: identity.cert })).not.toThrow();
  });
});
