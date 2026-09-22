import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CeConfig } from "../config/ce-config.ts";
import type { Env } from "../context.ts";
import { errorMessage, homeDir } from "../util.ts";
import type { Candidate, CandidateLoad } from "./candidate.ts";
import { createGitCache, type GitCache, isGitUrl } from "./git-cache.ts";
import { readCandidate } from "./learnings.ts";
import { enumeratePacks, escapingLinks, expandHome, isKnowledgeText } from "./packs.ts";

export type KnownSource = {
  label: string;
  kind: "local" | "git";
  /** As written in config or the built-in list (`~` preserved for declarations). */
  source: string;
  ref?: string;
  path?: string;
};

export type FetchPolicy = "cached-or-clone" | "cached-only" | "refresh";

export const HOME_SOURCE = "~/compound-packs/packs";
export const EVERY_SOURCE = "https://github.com/EveryInc/compound-packs.git";
/** A skill call must stay fast: an uncached known source gets this long to clone. */
const KNOWN_SOURCE_TIMEOUT_SECONDS = 30;

/** Built-in sources plus `pack_sources:` from both config layers, in that order (plan R23). */
export function knownSources(config: CeConfig, env: Env): KnownSource[] {
  const sources: KnownSource[] = [];
  if (isDirectory(join(homeDir(env), "compound-packs", "packs"))) {
    sources.push({ label: "built-in", kind: "local", source: HOME_SOURCE });
  }
  sources.push({
    label: "built-in",
    kind: "git",
    source: EVERY_SOURCE,
    ref: "main",
    path: "packs",
  });
  for (const entry of config.packSources) {
    if (isGitUrl(entry.source)) {
      const source: KnownSource = {
        label: entry.label,
        kind: "git",
        source: entry.source,
        ref: entry.ref ?? "main",
      };
      if (entry.path) source.path = entry.path;
      sources.push(source);
    } else {
      sources.push({ label: entry.label, kind: "local", source: entry.source });
    }
  }
  return sources;
}

/** The directory a local known source names, `~` and repo-relative paths resolved; undefined when absent. */
export function localSourceDir(source: string, repoRoot: string, home: string): string | undefined {
  const expanded = expandHome(source, home);
  const dir = isAbsolute(expanded) ? expanded : resolve(repoRoot, expanded);
  return isDirectory(dir) ? realpathSync(dir) : undefined;
}

/**
 * Pack candidates: every pack a known source publishes that the repo has not
 * declared, judged later from its README title and applies_when. Each carries
 * the exact `packs:` entry that would declare it.
 */
export function loadPackCandidates(
  config: CeConfig,
  declaredIds: ReadonlySet<string>,
  env: Env,
  policy: FetchPolicy = "cached-or-clone",
): CandidateLoad {
  const git = createGitCache(env, { defaultTimeoutSeconds: KNOWN_SOURCE_TIMEOUT_SECONDS });
  const home = homeDir(env);
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const source of knownSources(config, env)) {
    const located = locate(source, config.repoRoot, home, git, policy, warnings);
    if (!located) continue;
    const { dir, boundary } = located;
    for (const [id, packDir] of enumeratePacks(dir, boundary, [])) {
      if (declaredIds.has(id) || seen.has(id)) continue;
      // The same refusal the declared-packs path applies: nothing in a pack may
      // link outside its source, README included.
      if (escapingLinks(packDir, boundary).length) {
        warnings.push(
          `${source.label} source ${source.source}: pack \`${id}\` skipped (link(s) outside the source)`,
        );
        continue;
      }
      const readme = join(packDir, "README.md");
      let raw: string;
      try {
        raw = readFileSync(readme, "utf8");
      } catch (error) {
        warnings.push(`skipped ${id}/README.md from ${source.source}: ${errorMessage(error)}`);
        continue;
      }
      if (!isKnowledgeText(raw)) continue;
      const candidate = readCandidate(
        readme,
        `${id}/README.md`,
        "pack_candidate",
        id,
        "README.md",
        raw,
      );
      if ("error" in candidate) {
        warnings.push(`skipped ${id}/README.md from ${source.source}: ${candidate.error}`);
        continue;
      }
      candidate.declaration = declarationFor(source, id);
      candidates.push(candidate);
      seen.add(id);
    }
  }
  return { candidates, warnings };
}

function locate(
  source: KnownSource,
  repoRoot: string,
  home: string,
  git: GitCache,
  policy: FetchPolicy,
  warnings: string[],
): { dir: string; boundary: string } | undefined {
  const label = `${source.label} source ${source.source}`;
  if (source.kind === "local") {
    const dir = localSourceDir(source.source, repoRoot, home);
    if (!dir) {
      warnings.push(`${label}: directory does not exist; skipped`);
      return undefined;
    }
    return { dir, boundary: dir };
  }
  const ref = source.ref ?? "main";
  if (policy === "refresh") git.evict(source.source, ref);
  let checkout = git.cachedDir(source.source, ref);
  if (!checkout && policy === "cached-or-clone" && git.recentlyFailed(source.source, ref)) {
    warnings.push(
      `${label}: clone failed recently; skipped (run \`compound packs suggest --refresh\` to retry now)`,
    );
    return undefined;
  }
  if (!checkout && policy !== "cached-only")
    checkout = git.clone(source.source, ref, label, warnings);
  if (!checkout) {
    if (policy === "cached-only")
      warnings.push(`${label}: not cached; run \`compound packs suggest\` to fetch it`);
    return undefined;
  }
  const dir = source.path ? join(checkout, source.path) : checkout;
  if (!existsSync(dir)) {
    warnings.push(`${label}: path \`${source.path}\` does not exist at ${ref}; skipped`);
    return undefined;
  }
  return { dir: realpathSync(dir), boundary: realpathSync(checkout) };
}

export function declarationFor(source: KnownSource, id: string): Record<string, string> {
  if (source.kind === "local") return { source: source.source, pack: id };
  const declaration: Record<string, string> = { source: source.source, ref: source.ref ?? "main" };
  if (source.path) declaration.path = source.path;
  declaration.pack = id;
  return declaration;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
