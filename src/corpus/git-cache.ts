import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Env } from "../context.ts";

/**
 * The pack git cache, byte-compatible with the CE plugin's packs-resolve.py:
 * `<scratch>/ce-packs/<sha256(url\nref)>`, so a pack a skill already cloned is
 * not cloned again. Clones are atomic (temp dir, then rename) and every git
 * call is non-interactive with a bounded timeout.
 */
export type GitCache = {
  base: string | undefined;
  which: () => boolean;
  cachedDir: (url: string, ref: string) => string | undefined;
  clone: (url: string, ref: string, label: string, warnings: string[]) => string | undefined;
  evict: (url: string, ref: string) => void;
  lsRemote: (url: string, ref: string) => string | undefined;
  headCommit: (dir: string) => string | undefined;
};

const DEFAULT_TIMEOUT_SECONDS = 60;

/** `CE_PACKS_GIT_TIMEOUT` wins; otherwise the caller's default, otherwise 60 seconds. */
export function createGitCache(
  env: Env,
  options: { defaultTimeoutSeconds?: number } = {},
): GitCache {
  const timeoutSeconds =
    Number(env.CE_PACKS_GIT_TIMEOUT) || options.defaultTimeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  let hasGit: boolean | undefined;
  const base = cacheBase(env);
  const gitEnv = nonInteractiveGitEnv(env);
  const git = (args: string[], cwd?: string) =>
    spawnSync("git", args, {
      cwd,
      env: gitEnv,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const cache: GitCache = {
    base,
    which() {
      hasGit ??= spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
      return hasGit;
    },
    cachedDir(url, ref) {
      if (base === undefined) return undefined;
      const dest = join(base, cacheKey(url, ref));
      return trustedCheckout(dest) ? dest : undefined;
    },
    clone(url, ref, label, warnings) {
      if (!cache.which()) {
        warnings.push(`${label}: git binary not found; source skipped`);
        return undefined;
      }
      if (base === undefined) {
        warnings.push(`${label}: no writable cache root for git sources; source skipped`);
        return undefined;
      }
      const dest = join(base, cacheKey(url, ref));
      if (existsSync(dest) || isLink(dest)) {
        if (trustedCheckout(dest)) return dest;
        warnings.push(
          `${label}: cached checkout ${dest} is a symlink or not owned by this user; refetching`,
        );
        rmSync(dest, { recursive: true, force: true });
        if (existsSync(dest) || isLink(dest)) {
          warnings.push(
            `${label}: cannot replace untrusted cached checkout ${dest}; source skipped`,
          );
          return undefined;
        }
      }
      const tmp = mkdtempSync(join(base, `${cacheKey(url, ref)}.part-`));
      try {
        const cloned = git([
          "clone",
          "--quiet",
          "--depth",
          "1",
          "--no-recurse-submodules",
          "--branch",
          ref,
          "--end-of-options",
          url,
          tmp,
        ]);
        if (cloned.error && "code" in cloned.error && cloned.error.code === "ETIMEDOUT") {
          warnings.push(`${label}: git clone timed out after ${timeoutSeconds}s; source skipped`);
          return undefined;
        }
        if (cloned.status !== 0) {
          // A tag or branch clone failed; retry treating the ref as a commit sha.
          const fetched =
            git(["init", "--quiet", tmp]).status === 0 &&
            git(["fetch", "--quiet", "--depth", "1", "--end-of-options", url, ref], tmp).status ===
              0 &&
            git(["checkout", "--quiet", "FETCH_HEAD"], tmp).status === 0;
          if (!fetched) {
            warnings.push(`${label}: cannot fetch \`${ref}\` from ${url}; source skipped`);
            return undefined;
          }
        }
        if (!existsSync(dest)) {
          try {
            renameSync(tmp, dest);
          } catch {
            if (!existsSync(dest)) {
              warnings.push(`${label}: could not publish the clone to ${dest}; source skipped`);
              return undefined;
            }
          }
        }
        if (trustedCheckout(dest)) return dest;
        warnings.push(
          `${label}: cached checkout ${dest} is a symlink or not owned by this user; source skipped`,
        );
        return undefined;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    evict(url, ref) {
      if (base === undefined) return;
      rmSync(join(base, cacheKey(url, ref)), { recursive: true, force: true });
    },
    lsRemote(url, ref) {
      const result = git(["ls-remote", "--end-of-options", url, ref, `${ref}^{}`]);
      if (result.status !== 0) return undefined;
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      // Prefer the peeled tag object when present.
      const peeled = lines.find((line) => line.endsWith("^{}"));
      const chosen = peeled ?? lines[0];
      return chosen?.split(/\s+/)[0];
    },
    headCommit(dir) {
      const result = git(["rev-parse", "HEAD"], dir);
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
  };
  return cache;
}

export function cacheKey(url: string, ref: string): string {
  return createHash("sha256").update(`${url}\n${ref}`).digest("hex");
}

export function isGitUrl(source: string): boolean {
  return /^(https?|ssh|git|file):\/\//.test(source) || /^[\w.-]+@[\w.-]+:/.test(source);
}

function nonInteractiveGitEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_ASKPASS = out.GIT_ASKPASS || "true";
  const ssh = out.GIT_SSH_COMMAND || "ssh";
  if (!ssh.includes("BatchMode")) out.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes`;
  return out;
}

function cacheBase(env: Env): string | undefined {
  const configured = env.CE_PACKS_CACHE_ROOT;
  if (configured) {
    const root = resolve(configured);
    mkdirSync(root, { recursive: true });
    return root;
  }
  if (process.platform === "win32") {
    const root = join(env.LOCALAPPDATA || tmpdir(), "compound-engineering-packs");
    return privateRootUsable(root) ? root : undefined;
  }
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  for (const base of ["/tmp", env.TMPDIR || "/tmp"]) {
    const root = join(base, `compound-engineering-${uid}`);
    if (privateRootUsable(root)) {
      const packs = join(root, "ce-packs");
      if (privateRootUsable(packs)) return packs;
    }
  }
  return undefined;
}

function privateRootUsable(path: string): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) return false;
  }
  if (process.platform !== "win32") {
    if (!ownedDir(path)) return false;
    try {
      chmodSync(path, 0o700);
    } catch {
      return false;
    }
  }
  return existsSync(path) && statSync(path).isDirectory();
}

function ownedDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) return false;
    const uid = process.getuid?.();
    return uid === undefined || st.uid === uid;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A real directory, never a symlink, owned by this user (ownership is POSIX-only). */
export function trustedCheckout(path: string): boolean {
  if (isLink(path) || !existsSync(path) || !statSync(path).isDirectory()) return false;
  return process.platform === "win32" || ownedDir(path);
}
