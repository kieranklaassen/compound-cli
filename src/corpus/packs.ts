import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CeConfig, PackEntry } from "../config/ce-config.ts";
import { errorMessage } from "../util.ts";
import type { Candidate, CandidateLoad } from "./candidate.ts";
import { type GitCache, isGitUrl } from "./git-cache.ts";
import { readCandidate } from "./learnings.ts";

export type PackRoot = {
  id: string;
  dir: string;
  nested_rule_shaped: number;
  url?: string;
  ref?: string;
  /** Config label, kept off the public JSON. */
  label: string;
};

export type PacksResolution = {
  roots: PackRoot[];
  warnings: string[];
  errors: string[];
  entries: number;
};

const README = "readme.md";
const FRONTMATTER_CAP = 64 * 1024;
const TREE_URL =
  /^(?<base>https?:\/\/github\.com\/[^/\s]+\/[^/\s]+?)(?:\.git)?\/tree\/(?<ref>[^/\s]+)(?:\/(?<path>[^\s]*))?\/?$/;

export function resolvePacks(config: CeConfig, git: GitCache): PacksResolution {
  const roots: PackRoot[] = [];
  const warnings: string[] = [];
  const errors: string[] = [...config.errors];
  for (const entry of config.packs) {
    try {
      resolveEntry(entry, config.repoRoot, roots, warnings, errors, git);
    } catch (error) {
      errors.push(`${entry.label}: unexpected error resolving entry: ${errorMessage(error)}`);
    }
  }
  // First declaration wins: config.yaml precedes config.local.yaml.
  const byId = new Map<string, PackRoot>();
  const final: PackRoot[] = [];
  for (const root of roots) {
    const prev = byId.get(root.id);
    if (prev !== undefined) {
      errors.push(
        `duplicate pack id \`${root.id}\`: ${root.label} ignored, ${prev.label} kept (rename one with \`id:\`)`,
      );
      continue;
    }
    byId.set(root.id, root);
    final.push(root);
  }
  return { roots: final, warnings, errors, entries: config.packs.length };
}

/** The public JSON shape, identical to packs-resolve.py's output. */
export function publicResolution(resolution: PacksResolution) {
  return {
    roots: resolution.roots.map(({ label: _label, ...root }) => root),
    warnings: resolution.warnings,
    errors: resolution.errors,
    entries: resolution.entries,
  };
}

function resolveEntry(
  entry: PackEntry,
  repoRoot: string,
  roots: PackRoot[],
  warnings: string[],
  errors: string[],
  git: GitCache,
): void {
  const label = entry.label;
  if (!entry.source) {
    errors.push(`${label}: entry has no \`source:\``);
    return;
  }
  let { source, ref, path: subPath } = entry;
  const tree = TREE_URL.exec(source);
  if (tree?.groups) {
    const treeRef = tree.groups.ref ?? "";
    const treePath = tree.groups.path ?? "";
    if (ref !== undefined && ref !== treeRef) {
      errors.push(
        `${label}: tree URL pins ref \`${treeRef}\` but entry says \`ref: ${ref}\` (remove one)`,
      );
      return;
    }
    if (subPath !== undefined && trimSlashes(subPath) !== trimSlashes(treePath)) {
      errors.push(
        `${label}: tree URL path \`${treePath}\` conflicts with \`path: ${subPath}\` (remove one)`,
      );
      return;
    }
    source = tree.groups.base ?? source;
    ref = treeRef;
    subPath = treePath || undefined;
  }

  let sourceRoot: string;
  let boundary: string;
  let gitMeta: { url: string; ref: string } | undefined;
  if (isGitUrl(source)) {
    if (!ref) {
      errors.push(`${label}: git source \`${source}\` requires \`ref:\` (tag, sha, or branch)`);
      return;
    }
    if (ref.startsWith("-") || source.startsWith("-")) {
      errors.push(`${label}: git source/ref may not begin with \`-\``);
      return;
    }
    const checkout = git.clone(source, ref, label, warnings);
    if (checkout === undefined) {
      if (tree) {
        warnings.push(
          `${label}: if the branch name contains \`/\`, tree-URL parsing splits it wrong; use explicit \`ref:\` and \`path:\` fields`,
        );
      }
      return;
    }
    gitMeta = { url: source, ref };
    const candidateRoot = subPath ? join(checkout, subPath) : checkout;
    const realCheckout = realpathSync(checkout);
    if (!existsSync(candidateRoot)) {
      errors.push(`${label}: path \`${subPath}\` does not exist in ${source}@${ref}`);
      return;
    }
    const realRoot = realpathSync(candidateRoot);
    if (!within(realRoot, realCheckout)) {
      errors.push(`${label}: path \`${subPath}\` escapes the source checkout`);
      return;
    }
    if (!statSync(realRoot).isDirectory()) {
      errors.push(`${label}: path \`${subPath}\` does not exist in ${source}@${ref}`);
      return;
    }
    sourceRoot = realRoot;
    boundary = realCheckout;
  } else {
    if (ref !== undefined) {
      errors.push(`${label}: \`ref:\` is only valid on git sources; path sources are read live`);
      return;
    }
    if (subPath !== undefined) {
      errors.push(
        `${label}: \`path:\` is only valid on git sources; point \`source:\` at the directory instead`,
      );
      return;
    }
    const expanded = expandHome(source);
    if (isAbsolute(expanded)) {
      if (!existsSync(expanded)) {
        errors.push(`${label}: source directory \`${source}\` does not exist`);
        return;
      }
      sourceRoot = realpathSync(expanded);
      boundary = sourceRoot;
    } else {
      const repoReal = realpathSync(repoRoot);
      const joined = join(repoRoot, expanded);
      if (!existsSync(joined)) {
        errors.push(`${label}: source directory \`${source}\` does not exist`);
        return;
      }
      sourceRoot = realpathSync(joined);
      if (!within(sourceRoot, repoReal) || within(sourceRoot, join(repoReal, ".git"))) {
        errors.push(`${label}: repo-relative source \`${source}\` resolves outside the repository`);
        return;
      }
      boundary = repoReal;
    }
    if (!statSync(sourceRoot).isDirectory()) {
      errors.push(`${label}: source directory \`${source}\` does not exist`);
      return;
    }
  }

  let selfName: string | undefined;
  if (gitMeta) {
    const tail = (subPath ?? source).replace(/\/+$/, "").split("/").pop() ?? "";
    selfName =
      tail
        .split(":")
        .pop()
        ?.replace(/\.git$/, "") || undefined;
  }
  const escaped: string[] = [];
  const published = enumeratePacks(sourceRoot, boundary, escaped, selfName);
  for (const link of escaped) {
    warnings.push(
      `${label}: skipped \`${relative(sourceRoot, link)}\` in \`${source}\` (it links outside the source)`,
    );
  }
  if (published.size === 0) {
    warnings.push(
      `${label}: source \`${source}\` publishes no packs (no directories with valid knowledge files)`,
    );
    for (const [name, child] of containedChildDirs(sourceRoot, boundary, [])) {
      const nested = nestedRulesWarning(name, child, boundary);
      if (nested) warnings.push(`${label}: ${nested}`);
    }
    return;
  }

  let selected: Map<string, string>;
  if (entry.pack === undefined) {
    selected = new Map(published);
  } else {
    const wanted = Array.isArray(entry.pack) ? entry.pack : [entry.pack];
    if (wanted.length === 0) {
      warnings.push(`${label}: \`pack:\` lists no ids; nothing installed from \`${source}\``);
      return;
    }
    const missing = wanted.filter((w) => !published.has(w));
    if (missing.length) {
      errors.push(
        `${label}: pack id(s) ${missing.join(", ")} not published by \`${source}\` (available: ${[...published.keys()].sort().join(", ") || "none"})`,
      );
      return;
    }
    selected = new Map(wanted.map((w) => [w, published.get(w) as string]));
  }
  if (entry.id !== undefined) {
    if (selected.size !== 1) {
      errors.push(`${label}: \`id:\` override requires the entry to install exactly one pack`);
      return;
    }
    const only = [...selected.values()][0] as string;
    selected = new Map([[entry.id, only]]);
  }

  for (const [packId, packDir] of selected) {
    const leaks = escapingLinks(packDir, boundary);
    if (leaks.length) {
      const names = leaks.map((p) => `\`${relative(packDir, p)}\``).join(", ");
      errors.push(
        `${label}: pack \`${packId}\` not published (${names} link(s) outside the source)`,
      );
      continue;
    }
    for (const child of containedMdFiles(packDir, boundary, [])) {
      if (!isKnowledgeFile(child)) {
        warnings.push(
          `${label}: skipped pack file \`${packId}/${basename(child)}\` (missing \`title\`/\`applies_when\` frontmatter)`,
        );
      }
    }
    const root: PackRoot = {
      id: packId,
      dir: packDir,
      nested_rule_shaped: nestedRuleShaped(packDir, boundary).total,
      label,
    };
    if (gitMeta) {
      root.url = gitMeta.url;
      root.ref = gitMeta.ref;
    }
    roots.push(root);
  }
}

/** Map published pack id to dir: self when the root holds rules, else immediate children. */
export function enumeratePacks(
  sourceRoot: string,
  boundary: string,
  escaped: string[],
  selfName?: string,
): Map<string, string> {
  if (hasKnowledgeFiles(sourceRoot, boundary, escaped)) {
    return new Map([[selfName ?? basename(resolve(sourceRoot)), sourceRoot]]);
  }
  const packs = new Map<string, string>();
  for (const [name, child] of containedChildDirs(sourceRoot, boundary, escaped)) {
    if (hasKnowledgeFiles(child, boundary, escaped)) packs.set(name, child);
  }
  return packs;
}

/**
 * A rule opens with a `---` frontmatter block, closed within the cap, that
 * names `title:` and `applies_when:`. Same raw-text test as packs-resolve.py.
 */
export function isKnowledgeFile(path: string): boolean {
  try {
    return isKnowledgeText(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

export function isKnowledgeText(raw: string): boolean {
  let text = raw.slice(0, FRONTMATTER_CAP);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return false;
  const fm = lines.slice(1, end).join("\n");
  return /^\s*title:/m.test(fm) && /^\s*applies_when:/m.test(fm);
}

export function containedMdFiles(directory: string, boundary: string, escaped: string[]): string[] {
  const files: string[] = [];
  for (const name of listNames(directory)) {
    if (!name.endsWith(".md") || name.toLowerCase() === README) continue;
    const child = join(directory, name);
    if (within(safeRealpath(child), boundary)) files.push(child);
    else escaped.push(child);
  }
  return files;
}

export function containedChildDirs(
  directory: string,
  boundary: string,
  escaped: string[],
): Array<[string, string]> {
  const dirs: Array<[string, string]> = [];
  for (const name of listNames(directory)) {
    const child = join(directory, name);
    if (name.startsWith(".")) continue;
    let isDir = false;
    try {
      isDir = statSync(child).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (within(safeRealpath(child), boundary)) dirs.push([name, child]);
    else escaped.push(child);
  }
  return dirs;
}

function hasKnowledgeFiles(directory: string, boundary: string, escaped: string[]): boolean {
  return containedMdFiles(directory, boundary, escaped).some(isKnowledgeFile);
}

/** Symlinks anywhere under `root` whose target leaves `boundary`. */
export function escapingLinks(root: string, boundary: string): string[] {
  const leaks: string[] = [];
  const walk = (dir: string) => {
    for (const name of listNames(dir)) {
      const child = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        if (!within(safeRealpath(child), boundary)) leaks.push(child);
        continue;
      }
      if (st.isDirectory()) walk(child);
    }
  };
  walk(root);
  return leaks.sort();
}

export function nestedRuleShaped(
  packDir: string,
  boundary: string,
): { total: number; dirs: string[] } {
  const dirs: string[] = [];
  let total = 0;
  for (const [name, child] of containedChildDirs(packDir, boundary, [])) {
    const count = containedMdFiles(child, boundary, []).filter(isKnowledgeFile).length;
    if (count) {
      dirs.push(name);
      total += count;
    }
  }
  return { total, dirs };
}

function nestedRulesWarning(packId: string, packDir: string, boundary: string): string | undefined {
  const { total, dirs } = nestedRuleShaped(packDir, boundary);
  if (!dirs.length) return undefined;
  const where = dirs.map((d) => `\`${d}/\``).join(", ");
  return `pack \`${packId}\` has ${total} rule-shaped file(s) under ${where} that discovery never reads (move rules to the pack's top level)`;
}

/** Every top-level rule of every resolved pack as a candidate. */
export function loadPackRules(roots: PackRoot[]): CandidateLoad {
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  for (const root of roots) {
    for (const file of containedMdFiles(root.dir, root.dir, [])) {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!isKnowledgeText(raw)) continue;
      const name = basename(file);
      const candidate = readCandidate(file, `${root.id}/${name}`, "pack_rule", root.id, name, raw);
      if ("error" in candidate) {
        warnings.push(`skipped ${root.id}/${name}: ${candidate.error}`);
        continue;
      }
      candidates.push(candidate);
    }
  }
  return { candidates, warnings };
}

export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function within(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + sep);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function listNames(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}
