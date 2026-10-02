import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PeerError } from "@aif/shared";

export interface PeerTlsIdentity {
  key: string;
  cert: string;
  fingerprint: string;
  deviceId: string;
}
const der = (tag: number, body: Buffer): Buffer => {
  let length: Buffer;
  if (body.length < 128) length = Buffer.from([body.length]);
  else {
    let hex = body.length.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    const value = Buffer.from(hex, "hex");
    length = Buffer.concat([Buffer.from([0x80 | value.length]), value]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const sequence = (...values: Buffer[]) => der(0x30, Buffer.concat(values));
const pem = (label: string, value: Buffer) =>
  `-----BEGIN ${label}-----\n${value
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END ${label}-----\n`;
export const certificateFingerprint = (raw: Buffer) =>
  createHash("sha256").update(raw).digest("hex");

/** A minimal self-signed Ed25519 X.509 identity (RFC 8410); trust is the explicit SHA-256 pin. */
export function generatePeerIdentity(deviceId: string): PeerTlsIdentity {
  z.uuid().parse(deviceId);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const algorithm = sequence(der(0x06, Buffer.from("2b6570", "hex")));
  const name = sequence(
    der(0x31, sequence(der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from(deviceId)))),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  // Fixed broad validity avoids making sync authority depend on clocks differing by a day.
  const validity = sequence(
    der(0x18, Buffer.from("20200101000000Z")),
    der(0x18, Buffer.from("21200101000000Z")),
  );
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ format: "der", type: "spki" }),
  );
  const raw = sequence(
    tbs,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), sign(null, tbs, privateKey)])),
  );
  return {
    deviceId,
    key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    cert: pem("CERTIFICATE", raw),
    fingerprint: certificateFingerprint(raw),
  };
}
export function loadPeerIdentity(
  deviceId: string,
  directory = join(homedir(), ".aif-handoff"),
): PeerTlsIdentity {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "peer-identity.json");
  try {
    writeFileSync(path, JSON.stringify(generatePeerIdentity(deviceId)), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  const identity = z
    .object({ deviceId: z.uuid(), key: z.string(), cert: z.string(), fingerprint: z.string() })
    .strict()
    .parse(JSON.parse(readFileSync(path, "utf8")));
  const cert = new X509Certificate(identity.cert);
  if (
    identity.deviceId !== deviceId ||
    certificateFingerprint(cert.raw) !== identity.fingerprint ||
    !cert.checkPrivateKey(createPrivateKey(identity.key)) ||
    !cert.verify(cert.publicKey)
  )
    throw new PeerError("peer_identity_mismatch");
  return identity;
}
