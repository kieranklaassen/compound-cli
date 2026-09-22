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
  /** "\n" or "\r\n", from the first line break. */
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
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
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
  if (lines[0]?.trim() !== "---") return base;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() !== "---") continue;
    const frontmatterText = lines.slice(1, i).join(eol);
    const body = lines.slice(i + 1).join(eol);
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
  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(rawLine);
    const keyed = /^[A-Za-z_][A-Za-z0-9_]*:\s+(.*)$/.exec(rawLine);
    const value = (item ?? keyed)?.[1]?.trim();
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
  return match?.[1]?.replace(/[*_`]/g, "").trim() || undefined;
}
