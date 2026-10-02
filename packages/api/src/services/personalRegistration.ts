import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectExistingCheckout } from "@aif/shared";
import { listProjectCheckouts, ProjectBindingError } from "@aif/data";

export class ProjectManifestError extends Error {
  constructor(readonly code: "manifest_exists" | "unsafe_manifest_path") {
    super(code);
    this.name = "ProjectManifestError";
  }
}

/** Separate opt-in action; ordinary registration never creates this file. */
export function createPortableProjectManifest(projectId: string, checkoutId: string) {
  const binding = listProjectCheckouts(projectId).find((entry) => entry.id === checkoutId);
  if (!binding) throw new ProjectBindingError("project_not_found");
  const { rootPath } = inspectExistingCheckout(binding.localRoot);
  const directory = join(rootPath, ".ai-factory");
  if (!existsSync(directory)) mkdirSync(directory);
  const pathFromRoot = relative(rootPath, realpathSync(directory));
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ProjectManifestError("unsafe_manifest_path");
  }
  const manifest = { schemaVersion: 1, kind: "aif-handoff-project", projectId } as const;
  try {
    writeFileSync(
      join(directory, "handoff-project.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new ProjectManifestError("manifest_exists");
    }
    throw error;
  }
  return manifest;
}
