import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { UsageError } from "../errors.ts";

export type RepoRoot = { root: string; source: "override" | "git" | "walk" | "cwd" };

/**
 * The enclosing checkout: an explicit --root wins; otherwise git's answer,
 * then the nearest ancestor holding a .git entry, then the working directory
 * (a plain folder of learnings still works).
 */
export function resolveRepoRoot(cwd: string, override?: string): RepoRoot {
  if (override !== undefined) {
    const root = resolve(cwd, override);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new UsageError(`--root ${JSON.stringify(override)} is not a directory`);
    }
    return { root, source: "override" };
  }
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (git.status === 0 && git.stdout.trim()) return { root: git.stdout.trim(), source: "git" };
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(current, ".git"))) return { root: current, source: "walk" };
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { root: resolve(cwd), source: "cwd" };
}
