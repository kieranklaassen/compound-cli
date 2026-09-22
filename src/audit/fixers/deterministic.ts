import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";
import {
  bareLiterals,
  DEFAULT_TYPED_KEYS,
  firstHeading,
  type SplitDocument,
  type TypedKeys,
} from "../document.ts";
import { DEFAULT_SCHEMA, type EffectiveField } from "../effective-schema.ts";
import { dateText, type Finding } from "../rules.ts";
import { LIMITS, normalizeEnum, normalizeTag, TAG_PATTERN } from "../schema.ts";
import type { FieldChange } from "../writer.ts";

/**
 * Fixes that need no judgment: a date the file's history already knows, an
 * enum spelled loosely, tags in the wrong case, a scalar where a list belongs,
 * a title the body's first heading already states, a value YAML misread. Each
 * takes the findings and returns the changes it can make; what it cannot, it
 * leaves to Jev or to the author. This is all of `--fix` without `--jev`.
 */

export type FixContext = {
  /** Absolute path, for git history. */
  absPath: string;
  /** Repo-relative path, for messages. */
  path: string;
  /** Skip git (tests, or a tree that is not a repository). */
  git?: boolean;
  /** The effective schema for the file's kind; the learning defaults when absent. */
  fields?: EffectiveField[];
};

export function deterministicFixes(
  doc: SplitDocument,
  findings: Finding[],
  context: FixContext,
): FieldChange[] {
  const rules = new Set(findings.map((f) => f.rule));
  const changes: FieldChange[] = [];
  const data = doc.data;
  const fields = context.fields ?? DEFAULT_SCHEMA.solution;
  const spec = (name: string) => fields.find((f) => f.name === name);
  // A later fixer for the same field replaces an earlier one (a recovered list may still need normalising).
  const upsert = (change: FieldChange) => {
    const index = changes.findIndex((c) => c.field === change.field);
    if (index >= 0) changes.splice(index, 1);
    changes.push(change);
  };

  if (rules.has("frontmatter.unsafe_scalar")) {
    for (const [field, value] of recoverUnsafeScalars(doc.frontmatterText, data)) {
      // A trailing comment on a value that is already valid stays a comment.
      if (typeof value === "string" && validAsIs(spec(field), data[field])) continue;
      upsert({
        field,
        value,
        source: "deterministic",
        note: "quoted the full value the parser had cut at ' #'",
      });
    }
  }

  if (rules.has("frontmatter.bare_literal")) {
    const typedKeys = {
      strings: new Set(
        fields.filter((f) => f.type !== "list" && f.type !== "date").map((f) => f.name),
      ),
      lists: new Set(fields.filter((f) => f.type === "list").map((f) => f.name)),
    };
    for (const [field, value] of recoverBareLiterals(doc.frontmatterText, data, typedKeys)) {
      upsert({
        field,
        value,
        source: "deterministic",
        note: "quoted a value YAML reads as null, a boolean, or a number",
        quote: true,
      });
    }
  }
  /** The value a later fixer should start from: what an earlier one recovered, else the parsed data. */
  const current = (field: string): unknown =>
    changes.find((c) => c.field === field)?.value ?? data[field];

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

  // Any closed field spelled loosely: `Best Practice`, `ui-bug`, ` HIGH `.
  for (const field of fields) {
    if (!field.closed || !rules.has(`${field.name}.invalid`)) continue;
    const normalised = normalizeEnum(current(field.name), field.values);
    if (normalised) {
      upsert({
        field: field.name,
        value: normalised,
        source: "deterministic",
        note: "normalised the spelling",
      });
    }
  }

  const tagsField = spec("tags");
  const tagsDuplicate = findings.some((f) => f.rule === "list.duplicate" && f.field === "tags");
  if (
    tagsField &&
    (rules.has("tags.not_a_list") ||
      rules.has("tags.format") ||
      rules.has("tags.too_many") ||
      rules.has("tags.empty_item") ||
      tagsDuplicate)
  ) {
    const max = tagsField.maxItems ?? LIMITS.tagsMax;
    const pattern = new RegExp(tagsField.pattern ?? TAG_PATTERN.source);
    const tags = normaliseTags(current("tags"), max);
    // Normalising toward the schema's style is only a fix when the repository's pattern accepts it.
    if (tags.length && tags.every((t) => pattern.test(t))) {
      upsert({
        field: "tags",
        value: tags,
        source: "deterministic",
        note: `lowercase, hyphenated, deduplicated, at most ${max}`,
      });
    }
  }

  for (const field of fields) {
    if (field.type !== "list" || field.name === "tags") continue;
    const value = current(field.name);
    if (rules.has(`${field.name}.not_a_list`) && typeof value === "string" && value.trim()) {
      upsert({
        field: field.name,
        value: [value.trim()],
        source: "deterministic",
        note: "wrapped the scalar in a list",
      });
    } else if (
      Array.isArray(value) &&
      findings.some((f) => f.rule === "list.duplicate" && f.field === field.name)
    ) {
      const deduped = dedupe(value.filter((v): v is string => typeof v === "string"));
      if (deduped.length !== value.length) {
        upsert({
          field: field.name,
          value: deduped,
          source: "deterministic",
          note: "removed duplicates",
        });
      }
    }
  }

  return changes;
}

export function normaliseTags(value: unknown, max: number = LIMITS.tagsMax): string[] {
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
  return dedupe(tags).slice(0, max);
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
function validAsIs(field: EffectiveField | undefined, value: unknown): boolean {
  if (!field || typeof value !== "string") return false;
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return field.closed && field.values.includes(value);
}

/**
 * `title: true` or `tags: [inbox, null]` parsed to a boolean and a null. The raw
 * text still has the words; put them back as strings (the writer quotes them).
 * A list is rebuilt only when its raw items line up with the parsed ones.
 */
export function recoverBareLiterals(
  frontmatterText: string,
  data: Record<string, unknown>,
  keys: TypedKeys = DEFAULT_TYPED_KEYS,
): Array<[string, string | string[]]> {
  const out = new Map<string, string | string[]>();
  const byField = new Map<string, Map<number, string>>();
  for (const literal of bareLiterals(frontmatterText, keys)) {
    if (literal.index === undefined) {
      // `yes` already parsed as a string under YAML 1.2; it is still set so the writer quotes it.
      out.set(literal.field, literal.value);
      continue;
    }
    const positions = byField.get(literal.field) ?? new Map<number, string>();
    positions.set(literal.index, literal.value);
    byField.set(literal.field, positions);
  }
  for (const [field, positions] of byField) {
    const parsed = data[field];
    if (!Array.isArray(parsed)) continue;
    const rebuilt = parsed.map((item, index) => {
      const raw = positions.get(index);
      if (raw !== undefined && typeof item !== "string") return raw;
      return typeof item === "string" ? item : undefined;
    });
    if (rebuilt.every((item): item is string => item !== undefined)) out.set(field, rebuilt);
  }
  return [...out.entries()];
}
