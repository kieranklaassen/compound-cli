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
