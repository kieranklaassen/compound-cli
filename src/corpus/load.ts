import { type CeConfig, loadCeConfig } from "../config/ce-config.ts";
import { resolveRepoRoot } from "../config/repo-root.ts";
import type { Env } from "../context.ts";
import { createGitCache, type GitCache } from "./git-cache.ts";
import { type LearningsLoad, loadLearnings } from "./learnings.ts";
import { loadPackRules, type PacksResolution, resolvePacks } from "./packs.ts";

export type Workspace = {
  repoRoot: string;
  config: CeConfig;
  git: GitCache;
};

export function openWorkspace(cwd: string, env: Env, rootOverride?: string): Workspace {
  const { root } = resolveRepoRoot(cwd, rootOverride);
  return { repoRoot: root, config: loadCeConfig(root), git: createGitCache(env) };
}

export type CorpusLoad = {
  learnings: LearningsLoad;
  packs: PacksResolution;
  packRules: ReturnType<typeof loadPackRules>;
  warnings: string[];
};

export function loadCorpus(workspace: Workspace): CorpusLoad {
  const learnings = loadLearnings(workspace.repoRoot, workspace.config.docsRootAbs);
  const packs = resolvePacks(workspace.config, workspace.git);
  const packRules = loadPackRules(packs.roots);
  return {
    learnings,
    packs,
    packRules,
    warnings: [...learnings.warnings, ...packs.warnings, ...packs.errors, ...packRules.warnings],
  };
}
