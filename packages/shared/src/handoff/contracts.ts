import { z } from "zod";

export const MAX_CONTEXT_FILE_BYTES = 1_048_576;
export const MAX_CONTEXT_BYTES = 8_388_608;
export const MAX_CONTEXT_FILES = 512;
export const snapshotDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Portable relative paths only, including Windows reserved names on other OSes. */
export function isPortableSnapshotPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    path === path.normalize("NFC") &&
    !/[\\:<>"|?*]/.test(path) &&
    ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
          part.toLowerCase() !== ".git",
      )
  );
}

export function isPortableContextPath(path: string): boolean {
  if (!isPortableSnapshotPath(path)) return false;
  const parts = path.toLowerCase().split("/");
  if (parts.some((part, index) => index > 0 && part.startsWith("."))) return false;
  if (
    parts.some((part) =>
      /^(?:\.env(?:\..*)?|node_modules|\.venv|\.ssh|sessions?|memories|auth(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|settings\.local\.json)$/.test(
        part,
      ),
    )
  )
    return false;
  if (/\.(?:pem|key|p12|pfx|mobileprovision|sqlite|db|log|jsonl)$/i.test(path)) return false;
  if (path === "AGENTS.md" || path === "CLAUDE.md") return true;
  if (path.startsWith("docs/agent-context/")) return /\.(?:md|txt|json|yaml|yml)$/i.test(path);
  if (path.startsWith(".ai-factory/")) return /\.(?:md|txt)$/i.test(path);
  if (/^\.agents\/skills\/[^/]+\/.+/.test(path))
    return /\.(?:md|txt|json|yaml|yml|toml|js|mjs|cjs|ts|py|sh|ps1)$/i.test(path);
  return /^\.codex\/agents\/[A-Za-z0-9_-]+\.(?:md|toml)$/.test(path);
}

export const portableContextPathSchema = z
  .string()
  .refine(isPortableContextPath, "Path is not portable project context");
const note = z.string().max(250_000);
const notes = z.array(z.string().max(10_000)).max(100);
export const continuationNotesSchema = z
  .object({
    goal: note.min(1),
    acceptanceCriteria: notes.default([]),
    completed: notes.default([]),
    nextStep: note.min(1),
    decisions: notes.default([]),
    openQuestions: notes.default([]),
    checks: z
      .array(
        z
          .object({
            command: z.string().min(1).max(10_000),
            outcome: z.enum(["passed", "failed", "blocked", "not_run"]),
            summary: z.string().max(10_000),
            artifactPaths: z.array(portableContextPathSchema).max(100).default([]),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type ContinuationNotes = z.infer<typeof continuationNotesSchema>;
export const contextFileSchema = z
  .object({
    path: portableContextPathSchema,
    source: z.enum(["git", "portable"]),
    digest: snapshotDigestSchema,
    size: z.number().int().min(0).max(MAX_CONTEXT_FILE_BYTES),
    gitBlob: gitObjectIdSchema.nullable(),
  })
  .strict()
  .superRefine((file, ctx) => {
    if ((file.source === "git") !== (file.gitBlob !== null))
      ctx.addIssue({
        code: "custom",
        message: "Git provenance is required only for tracked files",
      });
  });
export const contextManifestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    commitSha: gitObjectIdSchema,
    notes: continuationNotesSchema,
    plan: z.object({ text: note.nullable(), revision: snapshotDigestSchema }).strict(),
    files: z.array(contextFileSchema).max(MAX_CONTEXT_FILES),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    for (const file of manifest.files) {
      const key = file.path.toLowerCase();
      if (paths.has(key))
        ctx.addIssue({ code: "custom", message: "Case/Unicode collision in context paths" });
      paths.add(key);
    }
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++)
        if (paths.has(parts.slice(0, i).join("/")))
          ctx.addIssue({ code: "custom", message: "Context file/directory collision" });
    }
    if (manifest.files.reduce((sum, file) => sum + file.size, 0) > MAX_CONTEXT_BYTES)
      ctx.addIssue({ code: "custom", message: "Context package is too large" });
    for (const check of manifest.notes.checks)
      for (const path of check.artifactPaths) {
        if (!manifest.files.some((file) => file.path === path))
          ctx.addIssue({ code: "custom", message: "A check references an absent artifact" });
      }
  });
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export const codeSnapshotDescriptorSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    sourceDeviceId: z.uuid(),
    commitSha: gitObjectIdSchema,
    baseCommit: gitObjectIdSchema,
    objectFormat: z.enum(["sha1", "sha256"]),
    branchLabel: z.string().max(500).nullable(),
    parentSnapshotId: snapshotDigestSchema.nullable(),
    contextDigest: snapshotDigestSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const length = snapshot.objectFormat === "sha1" ? 40 : 64;
    if (snapshot.commitSha.length !== length || snapshot.baseCommit.length !== length)
      ctx.addIssue({ code: "custom", message: "Commit IDs do not match the object format" });
  });
export type CodeSnapshotDescriptor = z.infer<typeof codeSnapshotDescriptorSchema>;
export const codeSnapshotPackageSchema = z
  .object({
    id: snapshotDigestSchema,
    descriptor: codeSnapshotDescriptorSchema,
    context: contextManifestSchema,
    blobs: z
      .array(
        z
          .object({
            digest: snapshotDigestSchema,
            base64: z.string().max(Math.ceil(MAX_CONTEXT_FILE_BYTES / 3) * 4),
          })
          .strict(),
      )
      .max(MAX_CONTEXT_FILES),
  })
  .strict();
export type CodeSnapshotPackage = z.infer<typeof codeSnapshotPackageSchema>;
