import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export class ExistingCheckoutError extends Error {
  readonly code = "invalid_git_checkout";

  constructor() {
    super("Choose an existing Git working tree accessible on this device");
    this.name = "ExistingCheckoutError";
  }
}

/** Read-only inspection; .git files (linked worktrees) are supported by Git. */
export function inspectExistingCheckout(localRoot: string): {
  rootPath: string;
  head: string | null;
  branch: string | null;
  hasContext: boolean;
} {
  let rootPath: string;
  try {
    rootPath = realpathSync(localRoot);
  } catch {
    throw new ExistingCheckoutError();
  }
  const git = (args: string[], allowMissing = false): string | null => {
    const result = spawnSync(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      {
        cwd: rootPath,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (allowMissing && result.status === 1) return null;
    if (result.error || result.status !== 0) throw new ExistingCheckoutError();
    return result.stdout.trim();
  };
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new ExistingCheckoutError();
  }
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  if (!topLevel) throw new ExistingCheckoutError();
  rootPath = realpathSync(topLevel);
  return {
    rootPath,
    head: git(["rev-parse", "--verify", "--quiet", "HEAD"], true),
    branch: git(["symbolic-ref", "--quiet", "--short", "HEAD"], true),
    hasContext:
      existsSync(join(rootPath, ".ai-factory")) || existsSync(join(rootPath, "AGENTS.md")),
  };
}
