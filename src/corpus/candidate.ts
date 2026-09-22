export type CandidateKind = "solution" | "pack_rule" | "pack_candidate";

export type Frontmatter = Record<string, unknown>;

export type Candidate = {
  /** Stable id within one run, assigned after loading. */
  id: string;
  kind: CandidateKind;
  /** Repo-relative path for learnings; `<pack-id>/<file>` for pack items. */
  path: string;
  absPath: string;
  packId: string | undefined;
  /** Pack-relative path for pack items. */
  packPath: string | undefined;
  frontmatter: Frontmatter;
  title: string;
  appliesWhen: string[];
  tags: string[];
  body: string;
  /** 1-based line where the body starts in the file. */
  bodyStartLine: number;
  /** For pack candidates: the config entry that would declare the pack. */
  declaration: Record<string, string> | undefined;
};

export function hasAppliesWhen(candidate: Candidate): boolean {
  return candidate.appliesWhen.length > 0;
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((s) => s.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
