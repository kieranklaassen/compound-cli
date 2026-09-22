import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCasesFile } from "../src/bench/cases.ts";
import { aggregate, type CaseRun, latencyStats, scoreCase } from "../src/bench/score.ts";
import type { Candidate } from "../src/corpus/candidate.ts";
import { UsageError } from "../src/errors.ts";
import type { FindRun, ScoredCandidate } from "../src/find/result.ts";
import { cassetteEnv } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");

function candidate(path: string): Candidate {
  return {
    id: path,
    kind: "solution",
    path,
    absPath: `/x/${path}`,
    packId: undefined,
    packPath: undefined,
    frontmatter: {},
    title: path,
    appliesWhen: [],
    tags: [],
    body: "",
    bodyStartLine: 1,
    declaration: undefined,
  };
}

function scored(path: string, tierOne: number, score: number | null): ScoredCandidate {
  return {
    candidate: candidate(path),
    tierOneScore: tierOne,
    score,
    passage: null,
    matchedFields: [],
    overlap: null,
  };
}

function fakeRun(entries: ScoredCandidate[]): FindRun {
  return {
    scored: entries,
    result: {} as FindRun["result"],
  };
}

function caseRun(
  id: string,
  expected: string[],
  entries: ScoredCandidate[],
  negative = false,
): CaseRun {
  return {
    benchCase: { id, query: { activity: id }, expected, ...(negative ? { negative: true } : {}) },
    run: fakeRun(entries),
    corpusPaths: new Set(["p1", "p2", "p3"]),
    wall_ms: 500,
    requests: 3,
    input_tokens: 4000,
    estimated_usd: 0.0002,
  };
}

describe("scoreCase and aggregate", () => {
  const runs: CaseRun[] = [
    caseRun(
      "a",
      ["p1"],
      [scored("p1", 0.9, 0.95), scored("p2", 0.6, 0.55), scored("p3", 0.1, null)],
    ),
    caseRun(
      "b",
      ["p2", "p3"],
      [scored("p1", 0.2, null), scored("p2", 0.8, 0.7), scored("p3", 0.5, 0.45)],
    ),
    caseRun("c", ["p9"], [scored("p1", 0.1, null)]),
    caseRun("neg", [], [scored("p1", 0.3, 0.2), scored("p2", 0.6, 0.62)], true),
  ];

  test("per-case recall, precision lower bound, misses with rank, and negatives", () => {
    const a = scoreCase(runs[0] as CaseRun, 0.5);
    expect(a.recall).toBe(1);
    expect(a.hits).toEqual(["p1", "p2"]);
    expect(a.precision_lower_bound).toBe(0.5);
    const b = scoreCase(runs[1] as CaseRun, 0.5);
    expect(b.recall).toBe(0.5);
    expect(b.missed).toEqual([{ path: "p3", score: 0.45, tier_one_score: 0.5, rank: 2 }]);
    const neg = scoreCase(runs[3] as CaseRun, 0.5);
    expect(neg.correct_negative).toBe(false);
    expect(neg.recall).toBeNull();
  });

  test("an expected path missing from the corpus is a labeling error, not a miss", () => {
    const c = scoreCase(runs[2] as CaseRun, 0.5);
    expect(c.unknown_expected).toEqual(["p9"]);
    expect(c.recall).toBeNull();
    const agg = aggregate(
      runs.map((r) => scoreCase(r, 0.5)),
      0.5,
    );
    expect(agg.labeling_errors).toBe(1);
    expect(agg.positive_cases).toBe(2);
  });

  test("macro and micro recall, precision lower bound, and negatives aggregate as documented", () => {
    const agg = aggregate(
      runs.map((r) => scoreCase(r, 0.5)),
      0.5,
    );
    expect(agg.macro_recall).toBe(0.75);
    expect(agg.micro_recall).toBeCloseTo(2 / 3, 4);
    expect(agg.precision_lower_bound).toBeCloseTo(2 / 3, 4);
    expect(agg.negatives_correct).toBe(0);
    expect(agg.perfect_cases).toBe(1);
  });

  test("a sweep re-scores the same judgments at another threshold without new runs", () => {
    const strict = aggregate(
      runs.map((r) => scoreCase(r, 0.65)),
      0.65,
    );
    expect(strict.macro_recall).toBe(0.75);
    expect(strict.negatives_correct).toBe(1);
    const loose = aggregate(
      runs.map((r) => scoreCase(r, 0.4)),
      0.4,
    );
    expect(loose.macro_recall).toBe(1);
  });

  test("latency stats", () => {
    expect(latencyStats([300, 100, 200, 900, 400])).toEqual({
      median: 300,
      p90: 900,
      mean: 380,
      total: 1900,
    });
    expect(latencyStats([])).toEqual({ median: 0, p90: 0, mean: 0, total: 0 });
  });
});

describe("readCasesFile", () => {
  test("accepts the public gold set", () => {
    const file = readCasesFile(resolve(import.meta.dir, "../bench/cases/ce-plugin.json"));
    expect(file.name).toBe("ce-plugin");
    expect(file.corpus?.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(file.cases.length).toBeGreaterThan(30);
    expect(file.floor?.macro_recall).toBe(0.85);
  });

  test("rejects a positive case without expected paths and a negative case with them", () => {
    const dir = mkdtempSync(join(tmpdir(), "compound-cli-cases-"));
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        name: "x",
        corpus: null,
        cases: [{ id: "a", query: { activity: "a" }, expected: [] }],
      }),
    );
    expect(() => readCasesFile(bad)).toThrow(UsageError);
    writeFileSync(
      bad,
      JSON.stringify({
        name: "x",
        corpus: null,
        cases: [{ id: "a", query: {}, expected: ["p"], negative: true }],
      }),
    );
    expect(() => readCasesFile(bad)).toThrow(/must have an empty "expected"/);
    writeFileSync(
      bad,
      JSON.stringify({
        name: "x",
        corpus: null,
        cases: [
          { id: "a", query: {}, expected: ["p"] },
          { id: "a", query: {}, expected: ["p"] },
        ],
      }),
    );
    expect(() => readCasesFile(bad)).toThrow(/duplicate case id/);
  });
});

describe("compound bench command", () => {
  test("runs a local cases file against --root in replay and enforces the floor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compound-cli-bench-"));
    const cases = join(dir, "cases.json");
    writeFileSync(
      cases,
      JSON.stringify({
        name: "fixture",
        corpus: null,
        floor: { macro_recall: 0.99 },
        cases: [
          {
            id: "exit-codes",
            query: {
              activity:
                "Give the CLI a distinct exit code when a lookup finds nothing, so callers can tell it from a crash",
            },
            expected: ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
          },
          {
            id: "tls",
            query: {
              activity: "Rotate the TLS certificate on the load balancer before it expires",
            },
            expected: [],
            negative: true,
          },
        ],
      }),
    );
    const env = cassetteEnv(resolve(import.meta.dir, "fixtures/cassettes/bench-fixture"));
    const result = await runCli(
      [
        "bench",
        "--cases",
        cases,
        "--root",
        CORPUS,
        "--json",
        "--enforce-floor",
        "--sweep",
        "0.3,0.7",
      ],
      { env },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.aggregate.macro_recall).toBe(1);
    expect(report.aggregate.negatives_correct).toBe(1);
    expect(report.sweep.map((s: { threshold: number }) => s.threshold)).toEqual([0.3, 0.7]);
    expect(report.corpus.solutions).toBe(7);
    expect(report.cassette_mode).toBe("replay");
  });

  test("a cases file without a corpus block and no --root is a usage error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compound-cli-bench-"));
    const cases = join(dir, "cases.json");
    writeFileSync(
      cases,
      JSON.stringify({
        name: "x",
        corpus: null,
        cases: [{ id: "a", query: { activity: "a" }, expected: ["p"] }],
      }),
    );
    const result = await runCli(["bench", "--cases", cases], { env: { TYPESAFE_API_KEY: "k" } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--root");
  });

  test("bench without a key exits 3 before reading anything", async () => {
    const result = await runCli(["bench", "--cases", "bench/cases/ce-plugin.json"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });
});
