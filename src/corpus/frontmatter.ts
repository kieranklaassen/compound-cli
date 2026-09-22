import { parse } from "yaml";

/** Frontmatter must close within this many characters (packs-resolve.py's cap). */
export const FRONTMATTER_CAP = 64 * 1024;

export type ParsedDocument = {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number of the first body line. */
  bodyStartLine: number;
  hasFrontmatter: boolean;
};

export type FrontmatterError = { error: string };

export function parseFrontmatter(raw: string): ParsedDocument | FrontmatterError {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { data: {}, body: text, bodyStartLine: 1, hasFrontmatter: false };
  }
  let consumed = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    consumed += line.length + 1;
    if (consumed > FRONTMATTER_CAP) break;
    if (line.trim() === "---") {
      const block = lines.slice(1, i).join("\n");
      let data: unknown;
      try {
        data = block.trim() ? parse(block) : {};
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return { error: `invalid frontmatter YAML: ${message}` };
      }
      if (data === null || data === undefined) data = {};
      if (typeof data !== "object" || Array.isArray(data)) {
        return { error: "frontmatter is not a mapping" };
      }
      return {
        data: data as Record<string, unknown>,
        body: lines.slice(i + 1).join("\n"),
        bodyStartLine: i + 2,
        hasFrontmatter: true,
      };
    }
  }
  return { error: "frontmatter block never closes" };
}

export function isFrontmatterError(
  value: ParsedDocument | FrontmatterError,
): value is FrontmatterError {
  return "error" in value;
}

/** The first ATX H1 in a body, used as a title fallback. */
export function firstHeading(body: string): string | undefined {
  const match = body.match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || undefined;
}
