import { readFileSync } from "node:fs";
import { stringField } from "../corpus/candidate.ts";
import { documentTitle, parseFrontmatterLenient } from "../corpus/frontmatter.ts";

export type PlanSummary = {
  path: string;
  title: string;
  topic: string | null;
  summary: string;
  requirements: string[];
  decisions: string[];
};

const SUMMARY_CHARS = 1500;
const MAX_REQUIREMENTS = 40;
const MAX_DECISIONS = 20;

/** A bounded reading of a unified plan or brainstorm: title, summary, R-IDs, and decision labels. */
export function readPlan(path: string): PlanSummary {
  const { data, body } = parseFrontmatterLenient(readFileSync(path, "utf8"));
  return {
    path,
    title: documentTitle(data, body, path).replace(/\s+-\s+Plan$/, ""),
    topic: stringField(data.topic) ?? null,
    summary:
      sectionText(body, /^#{2,3}\s+Summary\b/m) ??
      sectionText(body, /^#{2,3}\s+(Goal Capsule|Objective)\b/m) ??
      firstParagraph(body),
    requirements: matches(body, /^\s*-\s+R\d+\.\s+(.+)$/gm, MAX_REQUIREMENTS),
    decisions: matches(
      sectionText(body, /^#{2,3}\s+Key (?:Technical )?Decisions\b/m) ?? "",
      /^\s*-\s+(?:KTD\d+\.\s+)?\*\*(.+?)\*\*/gm,
      MAX_DECISIONS,
    ),
  };
}

function sectionText(body: string, heading: RegExp): string | undefined {
  const start = body.search(heading);
  if (start === -1) return undefined;
  const afterHeading = body.indexOf("\n", start);
  if (afterHeading === -1) return undefined;
  const rest = body.slice(afterHeading + 1);
  const end = rest.search(/^#{1,3}\s/m);
  const text = (end === -1 ? rest : rest.slice(0, end)).trim();
  return text ? text.slice(0, SUMMARY_CHARS) : undefined;
}

function firstParagraph(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#") && !p.startsWith("---"));
  return (paragraphs[0] ?? "").slice(0, SUMMARY_CHARS);
}

function matches(body: string, pattern: RegExp, limit: number): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value) out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}
