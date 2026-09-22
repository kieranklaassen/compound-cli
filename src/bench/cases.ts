import { readFileSync } from "node:fs";
import { UsageError } from "../errors.ts";
import { errorMessage } from "../util.ts";

export type BenchQuery = {
  activity?: string;
  concepts?: string[];
  decisions?: string[];
  domains?: string[];
  modules?: string[];
  paths?: string[];
};

export type BenchCase = {
  id: string;
  query: BenchQuery;
  /** Repo-relative paths (learnings) or `<pack-id>/<file>` (pack rules). Positive-only labels. */
  expected: string[];
  negative?: boolean;
  note?: string;
};

export type BenchCorpus = {
  git: string;
  ref: string;
  docs_root?: string;
};

export type CasesFile = {
  name: string;
  description?: string;
  corpus: BenchCorpus | null;
  floor?: { macro_recall?: number; negatives_correct?: number; precision_lower_bound?: number };
  cases: BenchCase[];
};

export function readCasesFile(path: string): CasesFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UsageError(`cannot read cases file ${path}: ${errorMessage(error)}`);
  }
  if (!raw || typeof raw !== "object")
    throw new UsageError(`${path}: cases file must be a JSON object`);
  const file = raw as Partial<CasesFile>;
  if (typeof file.name !== "string") throw new UsageError(`${path}: missing "name"`);
  if (!Array.isArray(file.cases) || file.cases.length === 0)
    throw new UsageError(`${path}: "cases" must be a non-empty array`);
  const ids = new Set<string>();
  file.cases.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      throw new UsageError(`${path}: case ${index} needs a string "id"`);
    }
    if (ids.has(entry.id)) throw new UsageError(`${path}: duplicate case id "${entry.id}"`);
    ids.add(entry.id);
    if (!entry.query || typeof entry.query !== "object")
      throw new UsageError(`${path}: case "${entry.id}" needs a "query"`);
    if (!Array.isArray(entry.expected))
      throw new UsageError(`${path}: case "${entry.id}" needs an "expected" array`);
    if (entry.negative && entry.expected.length) {
      throw new UsageError(`${path}: negative case "${entry.id}" must have an empty "expected"`);
    }
    if (!entry.negative && entry.expected.length === 0) {
      throw new UsageError(
        `${path}: case "${entry.id}" has no expected paths; mark it "negative": true if nothing should match`,
      );
    }
  });
  if (file.corpus !== null && file.corpus !== undefined) {
    if (typeof file.corpus.git !== "string" || typeof file.corpus.ref !== "string") {
      throw new UsageError(`${path}: "corpus" needs "git" and "ref"`);
    }
  }
  return {
    name: file.name,
    ...(file.description !== undefined ? { description: file.description } : {}),
    corpus: file.corpus ?? null,
    ...(file.floor !== undefined ? { floor: file.floor } : {}),
    cases: file.cases as BenchCase[],
  };
}
