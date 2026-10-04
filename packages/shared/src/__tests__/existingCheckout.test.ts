import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExistingCheckoutError, inspectExistingCheckout } from "../existingCheckout.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "aif-attach-"));
  roots.push(base);
  const root = join(base, "repo");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(root, "tracked.txt"), "base\n");
  git("add", "tracked.txt");
  git("-c", "core.hooksPath=", "commit", "-m", "fixture");
  return { base, root, git };
}

describe("inspectExistingCheckout", () => {
  it("preserves dirty tracked/untracked files, index bytes, HEAD and refs", () => {
    const { root, git } = fixture();
    writeFileSync(join(root, "tracked.txt"), "staged\n");
    git("add", "tracked.txt");
    writeFileSync(join(root, "tracked.txt"), "unstaged\n");
    writeFileSync(join(root, "untracked.txt"), "private\n");
    writeFileSync(join(root, "AGENTS.md"), "existing context\n");
    const before = {
      index: readFileSync(join(root, ".git", "index")),
      head: git("rev-parse", "HEAD").trim(),
      refs: git("show-ref"),
      files: readdirSync(root).sort(),
    };
    expect(inspectExistingCheckout(root)).toEqual({
      rootPath: resolve(root),
      head: before.head,
      branch: "main",
      hasContext: true,
    });
    expect(readFileSync(join(root, ".git", "index"))).toEqual(before.index);
    expect(git("show-ref")).toBe(before.refs);
    expect(readdirSync(root).sort()).toEqual(before.files);
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("unstaged\n");
    expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("private\n");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("existing context\n");
  });

  it("accepts linked and detached worktrees without switching branches", () => {
    const { base, root, git } = fixture();
    const worktree = join(base, "worktree");
    git("worktree", "add", "--detach", worktree, "HEAD");
    const metadata = readFileSync(join(worktree, ".git"), "utf8");
    expect(inspectExistingCheckout(worktree)).toMatchObject({
      rootPath: resolve(worktree),
      branch: null,
    });
    expect(readFileSync(join(worktree, ".git"), "utf8")).toBe(metadata);
    expect(inspectExistingCheckout(root).branch).toBe("main");
  });

  it("supports an unborn checkout without creating the first commit", () => {
    const root = mkdtempSync(join(tmpdir(), "aif-unborn-"));
    roots.push(root);
    execFileSync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
    expect(inspectExistingCheckout(root)).toMatchObject({ head: null, branch: "main" });
  });

  it("rejects missing paths, plain directories and bare repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "aif-invalid-"));
    roots.push(root);
    expect(() => inspectExistingCheckout(join(root, "absent"))).toThrow(ExistingCheckoutError);
    expect(() => inspectExistingCheckout(root)).toThrow(ExistingCheckoutError);
    execFileSync("git", ["init", "--bare"], { cwd: root, windowsHide: true });
    expect(() => inspectExistingCheckout(root)).toThrow(ExistingCheckoutError);
  });
});
