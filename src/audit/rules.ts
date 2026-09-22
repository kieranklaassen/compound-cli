import { basename } from "node:path";
import type { CompoundConfig } from "../config/ce-config.ts";
import { bareLiterals, type SplitDocument, unsafeScalars } from "./document.ts";
import {
  buildEffectiveSchema,
  DEFAULT_SCHEMA,
  type DocumentKind,
  type EffectiveField,
  type EffectiveSchema,
  type Source,
  tagPatternOf,
} from "./effective-schema.ts";
import { normalizeEnum, PROBLEM_TYPES, TAG_PATTERN, type Track, trackOf } from "./schema.ts";

export type { DocumentKind } from "./effective-schema.ts";

export type Severity = "error" | "warning";

export type Fixer = "deterministic" | "jev" | null;

export type Finding = {
  rule: string;
  severity: Severity;
  field: string | null;
  message: string;
  /** A fixer exists for this finding (deterministic or Jev). */
  fixable: boolean;
  /** Which fixer handles it: deterministic first, Jev when spelling cannot settle it. */
  fixer: Fixer;
  /** Where the rule came from: the CLI's defaults, or the config layer that set it. */
  source: Source;
};

/**
 * The fixer class per rule id for the rules that are not derived from a field's
 * type; `fixerFor` derives the rest (an enum's `.invalid` is spelling first, a
 * closed field's `.missing` is a Jev choice). The README table is the prose form.
 */
export const FIXERS: Record<string, Fixer> = {
  "frontmatter.unsafe_scalar": "deterministic",
  "frontmatter.bare_literal": "deterministic",
  "title.missing": "deterministic",
  "date.missing": "deterministic",
  "date.invalid": "deterministic",
  "symptoms.missing": "jev",
  "applies_when.missing": "jev",
  "applies_when.generic": "jev",
  "tags.missing": "jev",
  "tags.format": "deterministic",
  "tags.too_many": "deterministic",
  "tags.empty_item": "deterministic",
  "list.duplicate": "deterministic",
};

/** Which fixer settles a rule on a field, from the explicit map or the field's type. */
export function fixerFor(rule: string, field: EffectiveField | undefined): Fixer {
  if (rule in FIXERS) return FIXERS[rule] ?? null;
  if (!field) return null;
  const check = rule.slice(field.name.length + 1);
  if (field.type === "list") {
    if (check === "not_a_list") return "deterministic";
    return null;
  }
  if (field.type === "date") return null;
  if (check === "missing")
    return field.values.length || isCorpusVocabulary(field.name) ? "jev" : null;
  if (check === "invalid") return field.closed ? "deterministic" : "jev";
  return null;
}

/** Fields whose values the corpus supplies when the schema lists none. */
export function isCorpusVocabulary(name: string): boolean {
  return name === "module" || name === "component" || name === "root_cause";
}

export const finding = (
  rule: string,
  severity: Severity,
  field: string | null,
  message: string,
  fixable = false,
  source: Source = "default",
  fixer?: Fixer,
): Finding => ({
  rule,
  severity,
  field,
  message,
  fixable,
  fixer: fixable ? (fixer === undefined ? (FIXERS[rule] ?? null) : fixer) : null,
  source,
});

/** Situations too vague to help a judge decide anything. */
const GENERIC_APPLIES_WHEN = [
  /^always$/i,
  /^any ?time$/i,
  /^general(ly)?$/i,
  /^when applicable$/i,
  /^as needed$/i,
  /^(when )?working (on|in) (this|the) (codebase|repo(sitory)?|project|app)$/i,
  /^(when )?(writing|changing|touching) code$/i,
  /^n\/?a$/i,
  /^tbd$/i,
  /^todo$/i,
];

const PLACEHOLDER_TITLES =
  /^(untitled|notes?|todo|learning|solution|draft|new (learning|document)|readme)$/i;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** An `applies_when` item that would not let a judge decide anything. */
export function isGenericAppliesWhen(item: string, title: string | undefined): boolean {
  const text = item.trim();
  if (!text) return true;
  if (GENERIC_APPLIES_WHEN.some((pattern) => pattern.test(text))) return true;
  if (text.split(/\s+/).length < 4) return true;
  if (title && jaccard(words(text), words(title)) >= 0.8) return true;
  return false;
}

/** A title that names nothing: a placeholder, the file slug, or under three words. */
export function isWeakTitle(title: string, path: string): boolean {
  const text = title.trim();
  if (!text) return true;
  if (PLACEHOLDER_TITLES.test(text)) return true;
  if (text.split(/\s+/).length < 3) return true;
  const slug = basename(path)
    .replace(/\.md$/i, "")
    .replace(/[-_]?\d{8}$/, "")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
  return text.toLowerCase() === slug;
}

/** Repo policy the rules read: the effective schema and the rules dropped from the report. */
export type RuleOptions = {
  schema: EffectiveSchema;
  ignore: Set<string>;
};

export type RuleContext = {
  path: string;
  kind: DocumentKind;
  /** For pack files, the pack id (a README's tags must carry it). */
  packId?: string;
  options?: RuleOptions;
};

/** Build the options from the config; the command checks `buildEffectiveSchema`'s errors first. */
export function ruleOptions(
  config: CompoundConfig,
  schema: EffectiveSchema = buildEffectiveSchema(config.fields).schema,
): RuleOptions {
  return { schema, ignore: new Set(config.audit.ignore) };
}

export const DEFAULT_OPTIONS: RuleOptions = { schema: DEFAULT_SCHEMA, ignore: new Set() };

/** Every finding for one document, after the repo's policy. Pure: no judge, no filesystem. */
export function runRules(doc: SplitDocument, context: RuleContext): Finding[] {
  const options = context.options ?? DEFAULT_OPTIONS;
  return applyPolicy(collect(doc, context, options), options);
}

/** Drop the rules the repo ignores. */
export function applyPolicy(findings: Finding[], options: RuleOptions): Finding[] {
  if (!options.ignore.size) return findings;
  return findings.filter((f) => !options.ignore.has(f.rule));
}

function collect(doc: SplitDocument, context: RuleContext, options: RuleOptions): Finding[] {
  const out: Finding[] = [];
  if (!doc.hasFrontmatter) {
    out.push(
      finding("frontmatter.missing", "error", null, "no frontmatter block at the top of the file"),
    );
    return out;
  }
  if (doc.unterminated) {
    out.push(finding("frontmatter.unterminated", "error", null, "frontmatter block never closes"));
    return out;
  }
  if (doc.parseError) {
    out.push(finding("frontmatter.invalid_yaml", "error", null, doc.parseError));
    return out;
  }
  for (const line of unsafeScalars(doc.frontmatterText)) {
    out.push(
      finding(
        "frontmatter.unsafe_scalar",
        "error",
        null,
        `unquoted value a strict parser misreads (quote it): ${line}`,
        true,
      ),
    );
  }
  const fields = options.schema[context.kind];
  const typedKeys = {
    strings: new Set(
      fields.filter((f) => f.type !== "list" && f.type !== "date").map((f) => f.name),
    ),
    lists: new Set(fields.filter((f) => f.type === "list").map((f) => f.name)),
  };
  for (const literal of bareLiterals(doc.frontmatterText, typedKeys)) {
    out.push(
      finding(
        "frontmatter.bare_literal",
        "error",
        literal.field,
        `${literal.field} value \`${literal.value}\` is read as null, a boolean, or a number, not a string (quote it)`,
        true,
      ),
    );
  }

  const data = doc.data;
  const title = typeof data.title === "string" ? data.title : undefined;
  const problemType = data.problem_type;
  const track: Track | null = fields.some((f) => f.name === "problem_type")
    ? trackOf(normalizeEnum(problemType, PROBLEM_TYPES) ?? problemType)
    : null;

  for (const field of fields) {
    const value = data[field.name];
    const before = out.length;
    fieldRules(field, value, track, out);
    const failed = out.length > before;
    if (field.name === "title" && !failed && title && isWeakTitle(title, context.path)) {
      out.push(
        finding(
          "title.weak",
          "warning",
          "title",
          "title is a placeholder, the file name, or under three words",
        ),
      );
    }
    if (field.name === "applies_when" && Array.isArray(value)) {
      const items = value.filter((v): v is string => typeof v === "string");
      const generic = items.filter((item) => isGenericAppliesWhen(item, title));
      if (generic.length) {
        out.push(
          finding(
            "applies_when.generic",
            "warning",
            "applies_when",
            `applies_when item${generic.length > 1 ? "s" : ""} too vague to decide on: ${generic
              .map((g) => `"${g}"`)
              .join(", ")}`,
            context.kind === "solution",
          ),
        );
      }
    }
    if (
      field.name === "tags" &&
      context.kind === "pack_readme" &&
      context.packId &&
      Array.isArray(value) &&
      !value.includes(context.packId)
    ) {
      out.push(
        finding(
          "pack.readme_tag_missing",
          "error",
          "tags",
          `README tags must include the pack id "${context.packId}"`,
        ),
      );
    }
  }
  return out;
}

const MISSING_MESSAGES: Record<string, string> = {
  applies_when: "applies_when is missing; the judge relies on it most",
  tags: "tags are missing",
};

/** One field against its effective spec: presence, type, values, bounds, pattern. */
function fieldRules(
  field: EffectiveField,
  value: unknown,
  track: Track | null,
  out: Finding[],
): void {
  const name = field.name;
  const missing =
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && value.length === 0);
  const emit = (
    check: string,
    severity: Severity,
    message: string,
    source: Source,
    fixable = true,
  ) => {
    const rule = `${name}.${check}`;
    const fixer = fixerFor(rule, field);
    out.push(finding(rule, severity, name, message, fixable && fixer !== null, source, fixer));
  };

  if (missing) {
    const required = field.required === "always" || (field.required === "bug" && track === "bug");
    if (field.required === "recommended") {
      const empty = Array.isArray(value) ? `${name} ${name === "tags" ? "are" : "is"} empty` : null;
      emit(
        "missing",
        "warning",
        empty ?? MISSING_MESSAGES[name] ?? `${name} is missing`,
        field.sources.required,
      );
    } else if (required) {
      const message =
        field.required === "bug"
          ? `bug-track learning has no ${name}`
          : Array.isArray(value)
            ? `${name} is empty`
            : `${name} is missing`;
      emit("missing", "error", message, field.sources.required);
    }
    return;
  }

  if (field.bugOnly && track === "knowledge") {
    emit(
      "bug_track_only",
      "error",
      `${name} is only valid on bug-track learnings`,
      field.sources.bugOnly,
      false,
    );
  }

  switch (field.type) {
    case "date": {
      if (!DATE.test(dateText(value))) {
        emit("invalid", "error", `${name} "${String(value)}" is not YYYY-MM-DD`, field.source);
      }
      return;
    }
    case "string":
    case "enum": {
      if (typeof value !== "string") {
        if (field.closed) {
          emit(
            "invalid",
            "error",
            `${name} "${String(value)}" is not ${valuesPhrase(field)}`,
            valuesSource(field),
          );
        } else {
          emit("not_a_string", "error", `${name} must be a single value`, field.source, false);
        }
        return;
      }
      if (field.closed && !field.values.includes(value.trim())) {
        emit(
          "invalid",
          "error",
          `${name} "${value}" is not ${valuesPhrase(field)}`,
          valuesSource(field),
        );
      } else if (field.pattern && !new RegExp(field.pattern).test(value.trim())) {
        emit(
          "invalid",
          "error",
          `${name} "${value}" does not match ${field.pattern}`,
          field.sources.pattern,
          false,
        );
      }
      return;
    }
    case "list": {
      listRules(field, value, out, emit);
      return;
    }
    default: {
      const exhaustive: never = field.type;
      throw new Error(`unknown field type ${String(exhaustive)}`);
    }
  }
}

/** "a schema value" for the defaults; the repository's list when a layer set it. */
function valuesPhrase(field: EffectiveField): string {
  if (valuesSource(field) === "default") return "a schema value";
  const shown = field.values.slice(0, 6).join(", ");
  return `in this repository's list (${shown}${field.values.length > 6 ? ", ..." : ""})`;
}

function valuesSource(field: EffectiveField): Source {
  return field.sources.closed !== "default" ? field.sources.closed : field.sources.values;
}

type Emit = (
  check: string,
  severity: Severity,
  message: string,
  source: Source,
  fixable?: boolean,
) => void;

function listRules(field: EffectiveField, value: unknown, out: Finding[], emit: Emit): void {
  const name = field.name;
  if (typeof value === "string") {
    emit("not_a_list", "error", `${name} is a string; it must be a list`, field.source);
    return;
  }
  if (!Array.isArray(value)) {
    emit("not_a_list", "error", `${name} must be a list of strings`, field.source, false);
    return;
  }
  const items = value.filter((v): v is string => typeof v === "string");
  if (items.length !== value.length) {
    emit("not_strings", "error", `${name} has an item that is not a string`, field.source, false);
  }
  if (field.maxItems !== null && items.length > field.maxItems) {
    emit(
      "too_many",
      "warning",
      `${name} has ${items.length} items; the schema allows ${field.maxItems}`,
      field.sources.maxItems,
      name === "tags",
    );
  }
  if (field.minItems !== null && items.length > 0 && items.length < field.minItems) {
    emit(
      "too_few",
      "error",
      `${name} has ${items.length} item${items.length === 1 ? "" : "s"}; at least ${field.minItems} are needed`,
      field.sources.minItems,
      false,
    );
  }
  const pattern = field.pattern ? new RegExp(field.pattern) : null;
  const defaultTagPattern = name === "tags" && field.pattern === TAG_PATTERN.source;
  const seen = new Set<string>();
  let duplicate = false;
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    if (field.maxChars !== null && item.length > field.maxChars) {
      emit(
        "item_too_long",
        "warning",
        `${name} item is ${item.length} characters; the judge reads at most ${field.maxChars}`,
        field.sources.maxChars,
        false,
      );
    }
    if (!item.trim()) {
      emit("empty_item", "warning", `${name} has an empty item`, field.source);
    } else if (pattern && !pattern.test(item)) {
      emit(
        "format",
        "warning",
        defaultTagPattern
          ? `tag "${item}" is not lowercase and hyphen-separated`
          : `${name} item "${item}" does not match ${field.pattern}`,
        field.sources.pattern,
      );
    }
  }
  if (duplicate) {
    out.push(
      finding(
        "list.duplicate",
        "warning",
        name,
        `${name} repeats an item`,
        true,
        field.source,
        "deterministic",
      ),
    );
  }
}

/** The compiled tag pattern a fixer should normalise toward for a kind. */
export function tagPatternFor(options: RuleOptions, kind: DocumentKind): RegExp {
  return tagPatternOf(options.schema, kind);
}

/** YAML parses an unquoted 2026-01-02 as a Date; the audit compares text. */
export function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}
