import { parse } from "yaml";
import { errorMessage } from "../util.ts";

/**
 * A learning file split into the pieces the audit reads and the writer
 * reassembles: the frontmatter text between the delimiters, its parsed data,
 * and the body bytes, which are never touched.
 */
export type SplitDocument = {
  /** Original text, BOM included if there was one. */
  raw: string;
  bom: string;
  /** "\n" or "\r\n", from the first line break; used for the delimiter lines the writer emits. */
  eol: string;
  hasFrontmatter: boolean;
  /** Frontmatter text between the delimiter lines, without them. */
  frontmatterText: string;
  data: Record<string, unknown>;
  /** null when the block parses; a message otherwise. */
  parseError: string | null;
  /** True when the opening delimiter has no closing line. */
  unterminated: boolean;
  /** Everything after the closing delimiter line, byte for byte. */
  body: string;
};

export function splitDocument(raw: string): SplitDocument {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  const firstBreak = text.indexOf("\n");
  const eol = firstBreak > 0 && text[firstBreak - 1] === "\r" ? "\r\n" : "\n";
  const base: SplitDocument = {
    raw,
    bom,
    eol,
    hasFrontmatter: false,
    frontmatterText: "",
    data: {},
    parseError: null,
    unterminated: false,
    body: text,
  };
  // Walk delimiter lines by offset so the body is a substring of the original
  // text, whatever mix of line endings it carries.
  const firstLineEnd = firstBreak === -1 ? text.length : firstBreak;
  if (text.slice(0, firstLineEnd).trim() !== "---") return base;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end);
    if (line.trim() !== "---") {
      if (lineEnd === -1) break;
      lineStart = lineEnd + 1;
      continue;
    }
    const frontmatterText = text.slice(firstLineEnd + 1, lineStart).replace(/\r?\n$/, "");
    const body = lineEnd === -1 ? "" : text.slice(lineEnd + 1);
    let data: Record<string, unknown> = {};
    let parseError: string | null = null;
    try {
      const parsed = frontmatterText.trim() ? parse(frontmatterText) : {};
      if (parsed === null || parsed === undefined) data = {};
      else if (typeof parsed !== "object" || Array.isArray(parsed))
        parseError = "frontmatter is not a mapping";
      else data = parsed as Record<string, unknown>;
    } catch (error) {
      parseError = `invalid frontmatter YAML: ${errorMessage(error).split("\n")[0]}`;
    }
    return { ...base, hasFrontmatter: true, frontmatterText, data, parseError, body };
  }
  return { ...base, hasFrontmatter: true, unterminated: true, body: "" };
}

/**
 * Unquoted scalar values a strict YAML parser reads differently from the
 * author's intent: `: ` becomes a nested mapping, ` #` a comment, and a
 * leading reserved indicator an error. From the plugin's validate-frontmatter.py
 * and the schema's quoting rule.
 */
export function unsafeScalars(frontmatterText: string): string[] {
  const bad: string[] = [];
  let inBlockScalar = false;
  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const topLevel = /^[A-Za-z_][A-Za-z0-9_]*:(?:\s+(.*))?$/.exec(rawLine);
    if (topLevel) {
      inBlockScalar = /^[|>]/.test((topLevel[1] ?? "").trim());
    } else if (inBlockScalar) {
      // Lines of a block scalar are prose, whatever they contain.
      continue;
    }
    const item = /^\s{0,2}-\s+(.*)$/.exec(rawLine);
    const value = (item ?? topLevel)?.[1]?.trim();
    if (!value) continue;
    if (/^["'[{|>]/.test(value)) continue;
    if (value.includes(": ") || value.includes(" #") || /^[`*&!%@?]/.test(value)) {
      bad.push(rawLine.trim());
    }
  }
  return bad;
}

/** The first H1 of a body, for a title fixer. */
export function firstHeading(body: string): string | undefined {
  const prose = body.replace(/```[\s\S]*?```/g, "");
  const match = /^#\s+(.+?)\s*$/m.exec(prose);
  // Only one strong span wrapping the whole heading is markup; backticks and
  // asterisks inside it (`m.*`, or two separate spans) are the author's text.
  return match?.[1]?.replace(/^(\*\*|__)((?:(?!\1).)+)\1$/, "$2").trim() || undefined;
}

/** Which frontmatter keys hold strings and which hold lists of strings, from the effective schema. */
export type TypedKeys = { strings: ReadonlySet<string>; lists: ReadonlySet<string> };

/** The learning schema's string and list fields; the default when no schema is given. */
export const DEFAULT_TYPED_KEYS: TypedKeys = {
  strings: new Set([
    "title",
    "module",
    "component",
    "problem_type",
    "severity",
    "root_cause",
    "resolution_type",
    "rails_version",
    "framework_version",
  ]),
  lists: new Set(["symptoms", "applies_when", "tags"]),
};

/** Bare words YAML parsers (1.1 or 1.2) read as null, a boolean, or a number instead of a string. */
const YAML_LITERAL = /^(null|~|true|false|yes|no|on|off|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/i;

export function isBareLiteral(value: string): boolean {
  return YAML_LITERAL.test(value.trim());
}

export type BareLiteral = {
  field: string;
  /** The raw text as the author wrote it. */
  value: string;
  /** Position in the list when the literal is a list item; absent for a scalar field. */
  index?: number;
};

/**
 * Unquoted values in string-typed fields, or items of string-list fields, that a
 * parser turns into null, a boolean, or a number: `tags: [inbox, null]` loses a
 * tag silently. Keys the schema does not type (`related_issues: [1665]`) are left alone.
 */
export function bareLiterals(
  frontmatterText: string,
  keys: TypedKeys = DEFAULT_TYPED_KEYS,
): BareLiteral[] {
  const out: BareLiteral[] = [];
  let currentKey: string | null = null;
  let index = 0;
  let inBlockScalar = false;
  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const keyed = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(rawLine);
    if (keyed) {
      currentKey = keyed[1] ?? null;
      index = 0;
      const value = (keyed[2] ?? "").trim();
      inBlockScalar = /^[|>]/.test(value);
      if (!currentKey) continue;
      if (
        keys.strings.has(currentKey) &&
        value &&
        !/^["'[{|>]/.test(value) &&
        isBareLiteral(value)
      ) {
        out.push({ field: currentKey, value });
      }
      if (!keys.lists.has(currentKey)) continue;
      if (value.startsWith("[")) {
        const inner = value.replace(/^\[|\]$/g, "").trim();
        (inner ? inner.split(",") : []).forEach((item, i) => {
          const text = item.trim();
          if (text && !/^["']/.test(text) && isBareLiteral(text)) {
            out.push({ field: currentKey as string, value: text, index: i });
          }
        });
      }
      continue;
    }
    if (inBlockScalar) continue;
    const item = /^\s{0,2}-\s+(.*)$/.exec(rawLine);
    if (item && currentKey && keys.lists.has(currentKey)) {
      const value = (item[1] ?? "").trim();
      if (value && !/^["']/.test(value) && isBareLiteral(value)) {
        out.push({ field: currentKey, value, index });
      }
      index++;
    }
  }
  return out;
}
