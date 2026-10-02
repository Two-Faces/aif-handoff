import type { CausalContext, SyncDot } from "./contracts.js";

export interface FieldVersion {
  dot: SyncDot;
  context: CausalContext;
  value: unknown;
}

export function dotKey(dot: SyncDot): string {
  return `${dot.streamKey}/${dot.sequence}`;
}

export function covers(context: CausalContext, dot: SyncDot): boolean {
  return (context[dot.streamKey] ?? 0) >= dot.sequence;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Expected a JSON value");
  return encoded;
}

/** Keep causal maxima; a stable display order never discards concurrent values. */
export function mergeFieldVersions(versions: FieldVersion[]): FieldVersion[] {
  const unique = new Map<string, FieldVersion>();
  for (const version of versions) {
    const key = dotKey(version.dot);
    const previous = unique.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(version)) {
      throw new TypeError("Conflicting content for one revision");
    }
    unique.set(key, version);
  }
  const all = [...unique.values()];
  return all
    .filter(
      (candidate) =>
        !all.some((other) => other !== candidate && covers(other.context, candidate.dot)),
    )
    .sort((a, b) => (dotKey(a.dot) < dotKey(b.dot) ? -1 : dotKey(a.dot) > dotKey(b.dot) ? 1 : 0));
}

export function hasFieldConflict(versions: FieldVersion[]): boolean {
  return new Set(versions.map((version) => canonicalJson(version.value))).size > 1;
}
