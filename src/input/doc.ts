import { readFileSync } from "node:fs";
import { stringList } from "../corpus/candidate.ts";
import { documentTitle, parseFrontmatterLenient } from "../corpus/frontmatter.ts";

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
  const { data, body } = parseFrontmatterLenient(readFileSync(path, "utf8"));
  return {
    path,
    title: documentTitle(data, body, path),
    frontmatter: data,
    applies_when: stringList(data.applies_when),
    tags: stringList(data.tags),
    excerpt: body.trim().slice(0, EXCERPT_CHARS),
    body,
  };
}
