import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Candidate, stringField, stringList } from "./candidate.ts";
import { firstHeading, isFrontmatterError, parseFrontmatter } from "./frontmatter.ts";

export type LearningsLoad = {
  candidates: Candidate[];
  warnings: string[];
  /** Files whose frontmatter failed to parse, with the reason. */
  malformed: Array<{ path: string; error: string }>;
  solutionsDir: string;
  exists: boolean;
};

export function loadLearnings(repoRoot: string, docsRootAbs: string): LearningsLoad {
  const solutionsDir = join(docsRootAbs, "solutions");
  const load: LearningsLoad = {
    candidates: [],
    warnings: [],
    malformed: [],
    solutionsDir,
    exists: existsSync(solutionsDir),
  };
  if (!load.exists) return load;
  for (const absPath of walkMarkdown(solutionsDir)) {
    const path = relative(repoRoot, absPath).split("\\").join("/");
    const candidate = readCandidate(absPath, path, "solution", undefined);
    if ("error" in candidate) {
      load.malformed.push({ path, error: candidate.error });
      load.warnings.push(`skipped ${path}: ${candidate.error}`);
      continue;
    }
    load.candidates.push(candidate);
  }
  load.candidates.sort((a, b) => a.path.localeCompare(b.path));
  return load;
}

/** Every `.md` under `dir`, depth-first, skipping hidden entries and symlinks. */
export function walkMarkdown(dir: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

export function readCandidate(
  absPath: string,
  path: string,
  kind: Candidate["kind"],
  packId: string | undefined,
): Candidate | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = parseFrontmatter(raw);
  if (isFrontmatterError(parsed)) return parsed;
  const title =
    stringField(parsed.data.title) ?? firstHeading(parsed.body) ?? basename(path, ".md");
  return {
    id: path,
    kind,
    path,
    absPath,
    packId,
    frontmatter: parsed.data,
    title,
    appliesWhen: stringList(parsed.data.applies_when),
    tags: stringList(parsed.data.tags),
    body: parsed.body,
    bodyStartLine: parsed.bodyStartLine,
    declaration: undefined,
  };
}
