import { basename } from "node:path";
import { type SplitDocument, unsafeScalars } from "./document.ts";
import {
  LIMITS,
  normalizeEnum,
  PROBLEM_TYPES,
  RECORD_TYPES,
  RESOLUTION_TYPES,
  SEVERITIES,
  TAG_PATTERN,
  trackOf,
} from "./schema.ts";

export type Severity = "error" | "warning";
export type DocumentKind = "solution" | "pack_rule";

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
};

/** The fixer class per rule; the README table is the prose form of this map. */
export const FIXERS: Record<string, Fixer> = {
  "frontmatter.unsafe_scalar": "deterministic",
  "title.missing": "deterministic",
  "date.missing": "deterministic",
  "date.invalid": "deterministic",
  "problem_type.missing": "jev",
  "problem_type.invalid": "deterministic",
  "module.missing": "jev",
  "component.missing": "jev",
  "severity.missing": "jev",
  "severity.invalid": "deterministic",
  "symptoms.missing": "jev",
  "root_cause.missing": "jev",
  "resolution_type.missing": "jev",
  "resolution_type.invalid": "deterministic",
  "applies_when.missing": "jev",
  "applies_when.generic": "jev",
  "applies_when.not_a_list": "deterministic",
  "symptoms.not_a_list": "deterministic",
  "tags.missing": "jev",
  "tags.format": "deterministic",
  "tags.too_many": "deterministic",
  "tags.not_a_list": "deterministic",
  "tags.empty_item": "deterministic",
  "list.duplicate": "deterministic",
};

const finding = (
  rule: string,
  severity: Severity,
  field: string | null,
  message: string,
  fixable = false,
): Finding => ({
  rule,
  severity,
  field,
  message,
  fixable,
  fixer: fixable ? (FIXERS[rule] ?? null) : null,
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

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === "string");
}

function checkList(
  field: string,
  value: unknown,
  out: Finding[],
  options: { max?: number; lowercase?: boolean; fixable: boolean },
): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    out.push(
      finding(
        `${field}.not_a_list`,
        "error",
        field,
        `${field} is a string; it must be a list`,
        true,
      ),
    );
    return [value];
  }
  const items = stringList(value);
  if (items === null) {
    out.push(finding(`${field}.not_a_list`, "error", field, `${field} must be a list of strings`));
    return null;
  }
  if (items.length !== (value as unknown[]).length) {
    out.push(
      finding(`${field}.not_strings`, "error", field, `${field} has an item that is not a string`),
    );
  }
  if (options.max !== undefined && items.length > options.max) {
    out.push(
      finding(
        `${field}.too_many`,
        "warning",
        field,
        `${field} has ${items.length} items; the schema allows ${options.max}`,
        options.fixable,
      ),
    );
  }
  const seen = new Set<string>();
  let duplicate = false;
  for (const item of items) {
    const key = item.trim().toLowerCase();
    if (seen.has(key)) duplicate = true;
    seen.add(key);
    if (item.length > LIMITS.itemChars) {
      out.push(
        finding(
          `${field}.item_too_long`,
          "warning",
          field,
          `${field} item is ${item.length} characters; the judge reads at most ${LIMITS.itemChars}`,
        ),
      );
    }
    if (options.lowercase && !TAG_PATTERN.test(item)) {
      out.push(
        finding(
          `${field}.format`,
          "warning",
          field,
          `tag "${item}" is not lowercase and hyphen-separated`,
          true,
        ),
      );
    }
    if (!item.trim()) {
      out.push(
        finding(`${field}.empty_item`, "warning", field, `${field} has an empty item`, true),
      );
    }
  }
  if (duplicate) {
    out.push(finding("list.duplicate", "warning", field, `${field} repeats an item`, true));
  }
  return items;
}

export type RuleContext = {
  path: string;
  kind: DocumentKind;
};

/** Every finding for one document. Pure: no judge, no filesystem. */
export function runRules(doc: SplitDocument, context: RuleContext): Finding[] {
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
  const data = doc.data;

  const title = typeof data.title === "string" ? data.title : undefined;
  if (!title?.trim()) {
    out.push(finding("title.missing", "error", "title", "title is missing", true));
  } else if (isWeakTitle(title, context.path)) {
    out.push(
      finding(
        "title.weak",
        "warning",
        "title",
        "title is a placeholder, the file name, or under three words",
      ),
    );
  }

  if (context.kind === "pack_rule") {
    packRuleRules(doc, out, title);
    return out;
  }

  const date = data.date;
  if (date === undefined || date === null || date === "") {
    out.push(finding("date.missing", "error", "date", "date is missing", true));
  } else if (!DATE.test(dateText(date))) {
    out.push(
      finding("date.invalid", "error", "date", `date "${String(date)}" is not YYYY-MM-DD`, true),
    );
  }

  const problemType = data.problem_type;
  if (problemType === undefined || problemType === null || problemType === "") {
    out.push(
      finding("problem_type.missing", "error", "problem_type", "problem_type is missing", true),
    );
  } else if (!(PROBLEM_TYPES as readonly string[]).includes(String(problemType))) {
    out.push(
      finding(
        "problem_type.invalid",
        "error",
        "problem_type",
        `problem_type "${String(problemType)}" is not a schema value`,
        true,
      ),
    );
  }

  if (typeof data.module !== "string" || !data.module.trim()) {
    out.push(finding("module.missing", "error", "module", "module is missing", true));
  }
  if (typeof data.component !== "string" || !data.component.trim()) {
    out.push(finding("component.missing", "error", "component", "component is missing", true));
  }

  const severity = data.severity;
  if (severity === undefined || severity === null || severity === "") {
    out.push(finding("severity.missing", "error", "severity", "severity is missing", true));
  } else if (!(SEVERITIES as readonly string[]).includes(String(severity))) {
    out.push(
      finding(
        "severity.invalid",
        "error",
        "severity",
        `severity "${String(severity)}" is not one of ${SEVERITIES.join(", ")}`,
        true,
      ),
    );
  }

  const track = trackOf(normalizeEnum(problemType, PROBLEM_TYPES) ?? problemType);
  if (track === "bug") {
    const symptoms = checkList("symptoms", data.symptoms, out, {
      max: LIMITS.symptomsMax,
      fixable: false,
    });
    if (symptoms === null || symptoms.length === 0) {
      out.push(
        finding(
          "symptoms.missing",
          "error",
          "symptoms",
          "bug-track learning has no symptoms",
          true,
        ),
      );
    }
    if (typeof data.root_cause !== "string" || !data.root_cause.trim()) {
      out.push(
        finding(
          "root_cause.missing",
          "error",
          "root_cause",
          "bug-track learning has no root_cause",
          true,
        ),
      );
    }
    const resolution = data.resolution_type;
    if (resolution === undefined || resolution === null || resolution === "") {
      out.push(
        finding(
          "resolution_type.missing",
          "error",
          "resolution_type",
          "bug-track learning has no resolution_type",
          true,
        ),
      );
    } else if (!(RESOLUTION_TYPES as readonly string[]).includes(String(resolution))) {
      out.push(
        finding(
          "resolution_type.invalid",
          "error",
          "resolution_type",
          `resolution_type "${String(resolution)}" is not a schema value`,
          true,
        ),
      );
    }
  } else {
    checkList("symptoms", data.symptoms, out, { max: LIMITS.symptomsMax, fixable: false });
    if (data.resolution_type !== undefined && data.resolution_type !== null) {
      if (!(RESOLUTION_TYPES as readonly string[]).includes(String(data.resolution_type))) {
        out.push(
          finding(
            "resolution_type.invalid",
            "error",
            "resolution_type",
            `resolution_type "${String(data.resolution_type)}" is not a schema value`,
            true,
          ),
        );
      }
    }
  }

  appliesWhenRules(data.applies_when, title, LIMITS.appliesWhenMax, out);
  tagRules(data.tags, out);
  return out;
}

function appliesWhenRules(
  value: unknown,
  title: string | undefined,
  max: number,
  out: Finding[],
): void {
  if (value === undefined || value === null) {
    out.push(
      finding(
        "applies_when.missing",
        "warning",
        "applies_when",
        "applies_when is missing; the judge relies on it most",
        true,
      ),
    );
    return;
  }
  const items = checkList("applies_when", value, out, { max, fixable: false });
  if (items === null) return;
  if (items.length === 0) {
    out.push(
      finding("applies_when.missing", "warning", "applies_when", "applies_when is empty", true),
    );
    return;
  }
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
        true,
      ),
    );
  }
}

function tagRules(value: unknown, out: Finding[]): void {
  if (value === undefined || value === null) {
    out.push(finding("tags.missing", "warning", "tags", "tags are missing", true));
    return;
  }
  const items = checkList("tags", value, out, {
    max: LIMITS.tagsMax,
    lowercase: true,
    fixable: true,
  });
  if (items !== null && items.length === 0) {
    out.push(finding("tags.missing", "warning", "tags", "tags are empty", true));
  }
}

/** compound-packs `validate-packs.py` rules for a top-level rule file. */
function packRuleRules(doc: SplitDocument, out: Finding[], title: string | undefined): void {
  const data = doc.data;
  if (data.applies_when === undefined || data.applies_when === null) {
    out.push(finding("applies_when.missing", "error", "applies_when", "applies_when is missing"));
  } else {
    const items = checkList("applies_when", data.applies_when, out, {
      max: LIMITS.packAppliesWhenMax,
      fixable: false,
    });
    if (items !== null && items.length === 0) {
      out.push(finding("applies_when.missing", "error", "applies_when", "applies_when is empty"));
    }
    if (items) {
      const generic = items.filter((item) => isGenericAppliesWhen(item, title));
      if (generic.length) {
        out.push(
          finding(
            "applies_when.generic",
            "warning",
            "applies_when",
            `applies_when item too vague to decide on: "${generic[0]}"`,
          ),
        );
      }
    }
  }
  if (data.tags === undefined || data.tags === null) {
    out.push(finding("tags.missing", "error", "tags", "tags are missing"));
  } else {
    const items = checkList("tags", data.tags, out, {
      max: LIMITS.tagsMax,
      lowercase: true,
      fixable: false,
    });
    if (items !== null && items.length === 0) {
      out.push(finding("tags.missing", "error", "tags", "tags are empty"));
    }
  }
  if (typeof data.module !== "string" || !data.module.trim()) {
    out.push(finding("module.missing", "error", "module", "module is missing"));
  }
  if (!(PROBLEM_TYPES as readonly string[]).includes(String(data.problem_type))) {
    out.push(
      finding(
        "problem_type.invalid",
        "error",
        "problem_type",
        `problem_type "${String(data.problem_type)}" is not a schema value`,
      ),
    );
  }
  if (!(RECORD_TYPES as readonly string[]).includes(String(data.record_type))) {
    out.push(
      finding(
        "record_type.invalid",
        "error",
        "record_type",
        `record_type "${String(data.record_type)}" must be one of ${RECORD_TYPES.join(", ")}`,
      ),
    );
  }
}

/** YAML parses an unquoted 2026-01-02 as a Date; the audit compares text. */
export function dateText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}
