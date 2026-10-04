import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hasFieldConflict,
  mergeFieldVersions,
  type FieldVersion,
} from "../sync/causality.js";
import { syncOperationSchema, syncStreamKey } from "../sync/contracts.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const a = syncStreamKey(id(1), id(2), id(3));
const b = syncStreamKey(id(1), id(4), id(5));

describe("causal field registers", () => {
  it("converges for every ordering while retaining concurrent variants", () => {
    const base = { dot: { streamKey: a, sequence: 1 }, context: {}, value: "base" };
    const left = { dot: { streamKey: a, sequence: 2 }, context: { [a]: 1 }, value: "Windows" };
    const right = { dot: { streamKey: b, sequence: 1 }, context: { [a]: 1 }, value: "Mac" };
    for (const order of [
      [base, left, right],
      [base, right, left],
      [left, base, right],
      [right, base, left],
      [left, right, base],
      [right, left, base],
    ]) {
      const result = order.reduce<FieldVersion[]>(
        (state, next) => mergeFieldVersions([...state, next]),
        [],
      );
      expect(result).toEqual(mergeFieldVersions([left, right]));
      expect(hasFieldConflict(result)).toBe(true);
    }
    const resolved = {
      dot: { streamKey: a, sequence: 3 },
      context: { [a]: 2, [b]: 1 },
      value: "Resolved",
    };
    expect(mergeFieldVersions([right, resolved, base, left])).toEqual([resolved]);
  });

  it("does not turn equal concurrent values into a visible conflict or discard their dots", () => {
    const versions = mergeFieldVersions([
      { dot: { streamKey: a, sequence: 1 }, context: {}, value: "same" },
      { dot: { streamKey: b, sequence: 1 }, context: {}, value: "same" },
    ]);
    expect(versions).toHaveLength(2);
    expect(hasFieldConflict(versions)).toBe(false);
    expect(canonicalJson({ b: 1, a: [null, "x"] })).toBe(canonicalJson({ a: [null, "x"], b: 1 }));
  });
});

describe("operation validation", () => {
  const valid = {
    protocolVersion: 1,
    schemaVersion: 1,
    operationId: id(6),
    originDeviceId: id(2),
    deviceIncarnation: id(3),
    projectId: id(1),
    streamKey: a,
    originSequence: 1,
    entityType: "project",
    entityId: id(1),
    intent: "create",
    actorKind: "participant",
    causalContext: {},
    fields: { name: "Project", groupName: null, pinnedAt: null, createdAt: "2026-10-02T00:00:00Z" },
  };
  it("accepts portable data and rejects local secrets/paths and foreign scope", () => {
    expect(syncOperationSchema.safeParse(valid).success).toBe(true);
    for (const operation of [
      { ...valid, sessionId: "private" },
      { ...valid, fields: { ...valid.fields, rootPath: "C:/private" } },
      { ...valid, entityId: id(99) },
      { ...valid, protocolVersion: 0 },
      { ...valid, causalContext: { [syncStreamKey(id(99), id(2), id(3))]: 1 } },
      { ...valid, originSequence: 3 },
      { ...valid, fields: { name: "incomplete" } },
      { ...valid, intent: "resolve", fields: { name: "choice" } },
    ])
      expect(syncOperationSchema.safeParse(operation).success).toBe(false);
  });
});
