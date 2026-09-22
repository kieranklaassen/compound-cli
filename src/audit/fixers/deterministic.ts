import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { firstHeading, type SplitDocument } from "../document.ts";
import { dateText, type Finding } from "../rules.ts";
import {
  LIMITS,
  normalizeEnum,
  normalizeTag,
  PROBLEM_TYPES,
  RESOLUTION_TYPES,
  SEVERITIES,
} from "../schema.ts";
import type { FieldChange } from "../writer.ts";

/**
 * Fixes that need no judgment: a date the file's history already knows, an
 * enum spelled loosely, tags in the wrong case, a scalar where a list belongs,
 * a title the body's first heading already states. Each takes the findings
 * and returns the changes it can make; what it cannot, it leaves to Jev or
 * to the author.
 */

export type FixContext = {
  /** Absolute path, for git history. */
  absPath: string;
  /** Repo-relative path, for messages. */
  path: string;
  /** Skip git (tests, or a tree that is not a repository). */
  git?: boolean;
};

export function deterministicFixes(
  doc: SplitDocument,
  findings: Finding[],
  context: FixContext,
): FieldChange[] {
  const rules = new Set(findings.map((f) => f.rule));
  const changes: FieldChange[] = [];
  const data = doc.data;

  if (rules.has("frontmatter.unsafe_scalar")) {
    for (const [field, value] of recoverUnsafeScalars(doc.frontmatterText, data)) {
      // A trailing comment on a value that is already valid stays a comment.
      if (typeof value === "string" && validAsIs(field, data[field])) continue;
      changes.push({
        field,
        value,
        source: "deterministic",
        note: "quoted the full value the parser had cut at ' #'",
      });
    }
  }

  if (rules.has("title.missing")) {
    const heading = firstHeading(doc.body);
    if (heading) {
      changes.push({
        field: "title",
        value: heading,
        source: "deterministic",
        note: "from the first heading",
      });
    }
  }

  if (rules.has("date.missing") || rules.has("date.invalid")) {
    const date =
      dateFromValue(data.date) ??
      dateFromName(context.path) ??
      (context.git === false ? undefined : dateFromGit(context.absPath));
    if (date) {
      const note = dateFromValue(data.date)
        ? "normalised the existing date"
        : dateFromName(context.path)
          ? "from the file name"
          : "from the file's first commit";
      changes.push({ field: "date", value: date, source: "deterministic", note });
    }
  }

  for (const [field, allowed, rule] of [
    ["problem_type", PROBLEM_TYPES, "problem_type.invalid"],
    ["severity", SEVERITIES, "severity.invalid"],
    ["resolution_type", RESOLUTION_TYPES, "resolution_type.invalid"],
  ] as const) {
    if (!rules.has(rule)) continue;
    const normalised = normalizeEnum(data[field], allowed);
    if (normalised) {
      changes.push({
        field,
        value: normalised,
        source: "deterministic",
        note: "normalised the spelling",
      });
    }
  }

  const tagsDuplicate = findings.some((f) => f.rule === "list.duplicate" && f.field === "tags");
  if (
    rules.has("tags.not_a_list") ||
    rules.has("tags.format") ||
    rules.has("tags.too_many") ||
    tagsDuplicate
  ) {
    const tags = normaliseTags(data.tags);
    if (tags.length) {
      changes.push({
        field: "tags",
        value: tags,
        source: "deterministic",
        note: "lowercase, hyphenated, deduplicated, at most 8",
      });
    }
  }

  for (const field of ["applies_when", "symptoms"] as const) {
    const value = data[field];
    if (rules.has(`${field}.not_a_list`) && typeof value === "string" && value.trim()) {
      changes.push({
        field,
        value: [value.trim()],
        source: "deterministic",
        note: "wrapped the scalar in a list",
      });
    } else if (rules.has("list.duplicate") && Array.isArray(value)) {
      const deduped = dedupe(value.filter((v): v is string => typeof v === "string"));
      if (
        deduped.length !== value.length &&
        findings.some((f) => f.rule === "list.duplicate" && f.field === field)
      ) {
        changes.push({
          field,
          value: deduped,
          source: "deterministic",
          note: "removed duplicates",
        });
      }
    }
  }

  return changes;
}

export function normaliseTags(value: unknown): string[] {
  // A scalar is a comma list when it has commas ("Rails, Active Record"), else one tag per word.
  const raw =
    typeof value === "string"
      ? value.split(value.includes(",") ? /,/ : /\s+/)
      : Array.isArray(value)
        ? value
        : [];
  const tags = raw
    .filter((v): v is string => typeof v === "string")
    .map(normalizeTag)
    .filter(Boolean);
  return dedupe(tags).slice(0, LIMITS.tagsMax);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

const ISO = /(\d{4})-(\d{2})-(\d{2})/;
const COMPACT = /(?:^|[-_])(\d{4})(\d{2})(\d{2})(?=[-_.]|$)/;

/** A date already present but not YYYY-MM-DD: a Date object, `2026/01/02`, `20260102`. */
export function dateFromValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = dateText(value);
  if (ISO.test(text) && /^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${(iso[2] ?? "").padStart(2, "0")}-${(iso[3] ?? "").padStart(2, "0")}`;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return undefined;
}

/** `...-20251113.md` or `2026-02-24-...md` in the file name. */
export function dateFromName(path: string): string | undefined {
  const name = basename(path).replace(/\.md$/i, "");
  const compact = COMPACT.exec(name);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = ISO.exec(name);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return undefined;
}

/** The date of the commit that added the file, when the tree is a repository. */
export function dateFromGit(absPath: string): string | undefined {
  // A shallow clone dates every file at the boundary commit; that is not the first commit.
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd: dirname(absPath),
    encoding: "utf8",
    timeout: 5000,
  });
  if (shallow.status !== 0 || shallow.stdout.trim() === "true") return undefined;
  const run = spawnSync(
    "git",
    ["log", "--diff-filter=A", "--follow", "--format=%as", "--", basename(absPath)],
    { cwd: dirname(absPath), encoding: "utf8", timeout: 5000 },
  );
  if (run.status !== 0) return undefined;
  const lines = run.stdout.trim().split("\n").filter(Boolean);
  const first = lines[lines.length - 1];
  return first && /^\d{4}-\d{2}-\d{2}$/.test(first) ? first : undefined;
}

/**
 * An unquoted ` #` makes YAML drop the rest of the value, so the parsed data
 * has already lost text. The raw frontmatter still has it: take the whole
 * remainder of the line as the value and let the writer quote it.
 */
export function recoverUnsafeScalars(
  frontmatterText: string,
  data: Record<string, unknown>,
): Array<[string, string | string[]]> {
  const out = new Map<string, string | string[]>();
  let currentKey: string | null = null;
  let inBlockScalar = false;
  let items: Array<{ raw: string; quoted: boolean; cut: boolean }> = [];
  const flush = () => {
    const key = currentKey;
    const parsed = key === null ? undefined : data[key];
    // Recover a list only when the parsed value is a flat list of strings with
    // one entry per collected item; anything nested or quoted is left alone.
    if (
      key !== null &&
      items.length &&
      items.some((i) => i.cut) &&
      Array.isArray(parsed) &&
      parsed.length === items.length &&
      parsed.every((v) => typeof v === "string")
    ) {
      out.set(
        key,
        items.map((item, index) =>
          item.cut && !item.quoted ? item.raw : (parsed[index] as string),
        ),
      );
    }
    items = [];
  };
  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const keyed = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(rawLine);
    if (keyed) {
      flush();
      currentKey = keyed[1] ?? null;
      const value = keyed[2]?.trim() ?? "";
      inBlockScalar = /^[|>]/.test(value);
      if (value && !/^["'[{|>]/.test(value) && value.includes(" #") && currentKey) {
        if (typeof data[currentKey] === "string") out.set(currentKey, value);
      }
      continue;
    }
    if (inBlockScalar) continue;
    const item = /^\s{0,2}-\s+(.*)$/.exec(rawLine);
    if (item && currentKey) {
      const value = (item[1] ?? "").trim();
      const quoted = /^["']/.test(value);
      items.push({ raw: value, quoted, cut: !quoted && value.includes(" #") });
    } else if (/^\s+\S/.test(rawLine)) {
      // Deeper nesting under this key: not a flat list, never rebuilt.
      items = [];
      currentKey = null;
    }
  }
  flush();
  return [...out.entries()];
}

/** An enum or date value the rules already accept needs no recovery. */
function validAsIs(field: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  switch (field) {
    case "problem_type":
      return (PROBLEM_TYPES as readonly string[]).includes(value);
    case "severity":
      return (SEVERITIES as readonly string[]).includes(value);
    case "resolution_type":
      return (RESOLUTION_TYPES as readonly string[]).includes(value);
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    default:
      return false;
  }
}
