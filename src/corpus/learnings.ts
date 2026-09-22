import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { errorMessage } from "../util.ts";
import { type Candidate, stringList } from "./candidate.ts";
import { documentTitle, isFrontmatterError, parseFrontmatter } from "./frontmatter.ts";

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
    const path = relative(repoRoot, absPath).replaceAll("\\", "/");
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
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
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
  packPath: string | undefined = undefined,
  /** The file's text when the caller already read it (pack rules are tested for shape first). */
  raw?: string,
): Candidate | { error: string } {
  if (raw === undefined) {
    try {
      raw = readFileSync(absPath, "utf8");
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }
  const parsed = parseFrontmatter(raw);
  if (isFrontmatterError(parsed)) return parsed;
  return {
    id: path,
    kind,
    path,
    absPath,
    packId,
    packPath,
    frontmatter: parsed.data,
    title: documentTitle(parsed.data, parsed.body, path),
    appliesWhen: stringList(parsed.data.applies_when),
    tags: stringList(parsed.data.tags),
    body: parsed.body,
    bodyStartLine: parsed.bodyStartLine,
    declaration: undefined,
  };
}
