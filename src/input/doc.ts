import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { stringField, stringList } from "../corpus/candidate.ts";
import { firstHeading, isFrontmatterError, parseFrontmatter } from "../corpus/frontmatter.ts";

export type DocSummary = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  applies_when: string[];
  tags: string[];
  excerpt: string;
  body: string;
};

const EXCERPT_CHARS = 2000;

/** A draft learning: frontmatter plus a bounded body excerpt (the full body is kept for overlap). */
export function readDoc(path: string): DocSummary {
  const raw = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(raw);
  const data = isFrontmatterError(parsed) ? {} : parsed.data;
  const body = isFrontmatterError(parsed) ? raw : parsed.body;
  return {
    path,
    title: stringField(data.title) ?? firstHeading(body) ?? basename(path, ".md"),
    frontmatter: data,
    applies_when: stringList(data.applies_when),
    tags: stringList(data.tags),
    excerpt: body.trim().slice(0, EXCERPT_CHARS),
    body,
  };
}
