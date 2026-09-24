import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCasesFile } from "../src/bench/cases.ts";
import {
  aggregate,
  type CaseRun,
  fBeta,
  latencyStats,
  recallAtPrecisionFloor,
  scoreCase,
} from "../src/bench/score.ts";
import type { Candidate } from "../src/corpus/candidate.ts";
import { UsageError } from "../src/errors.ts";
import type { FindRun, ScoredCandidate } from "../src/find/result.ts";
import { cassetteEnv, tempDir } from "./helpers/fixtures.ts";
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
    const dir = tempDir("compound-cli-cases-");
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

describe("F0.5 and recall at a precision floor", () => {
  const runs: CaseRun[] = [
    caseRun("a", ["p1"], [scored("p1", 0.9, 0.95), scored("p2", 0.6, 0.55)]),
    caseRun("b", ["p2", "p3"], [scored("p2", 0.8, 0.7), scored("p3", 0.5, 0.45)]),
    caseRun("neg", [], [scored("p1", 0.3, 0.2)], true),
  ];

  test("fBeta weighs precision over recall and handles the empty corners", () => {
    expect(fBeta(1, 0.5)).toBeCloseTo(0.8333, 4);
    expect(fBeta(0.5, 1)).toBeCloseTo(0.5556, 4);
    expect(fBeta(0, 0)).toBe(0);
    expect(fBeta(null, 1)).toBeNull();
  });

  test("the floored recall is the best recall whose precision meets the floor, ties resolving to the highest threshold", () => {
    const loose = recallAtPrecisionFloor(runs, 0.5);
    expect(loose.recall).toBe(1);
    expect(loose.threshold).toBe(0.45);
    expect(loose.precision_lower_bound).toBe(0.75);
    // Thresholds 0.6, 0.65, and 0.7 give the same hits; the report names the highest.
    const tight = recallAtPrecisionFloor(runs, 0.8);
    expect(tight.recall).toBeCloseTo(2 / 3, 4);
    expect(tight.threshold).toBe(0.7);
    expect(tight.precision_lower_bound).toBe(1);
    const strict = recallAtPrecisionFloor(runs, 1.01);
    expect(strict.recall).toBeNull();
    expect(strict.threshold).toBeNull();
  });

  test("a case whose plan or diff is not a file path is a usage error naming the case", () => {
    const dir = tempDir("compound-cli-cases-");
    for (const query of [{ plan: 5 }, { diff: [] }, { plan: "  " }]) {
      const path = join(dir, "bad.json");
      writeFileSync(
        path,
        JSON.stringify({ name: "t", corpus: null, cases: [{ id: "odd", query, expected: ["x"] }] }),
      );
      expect(() => readCasesFile(path)).toThrow(
        /case "odd" has a "(plan|diff)" that is not a file path/,
      );
    }
  });
});

describe("compound bench command", () => {
  test("runs a local cases file against --root in replay and enforces the floor", async () => {
    const dir = tempDir("compound-cli-bench-");
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
    // The deprecation line is the only thing on stderr.
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("deprecated");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.aggregate.macro_recall).toBe(1);
    expect(report.aggregate.negatives_correct).toBe(1);
    expect(report.sweep.map((s: { threshold: number }) => s.threshold)).toEqual([0.3, 0.7]);
    expect(report.corpus.solutions).toBe(7);
    expect(report.cassette_mode).toBe("replay");
  });

  test("--jobs runs cases concurrently with per-case usage, --precision-floor reports the floored recall, and the text report renders both", async () => {
    const dir = tempDir("compound-cli-bench-");
    const cases = join(dir, "cases.json");
    writeFileSync(
      cases,
      JSON.stringify({
        name: "fixture",
        corpus: null,
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
    const args = [
      "bench",
      "--cases",
      cases,
      "--root",
      CORPUS,
      "--jobs",
      "2",
      "--precision-floor",
      "0.9",
    ];
    const json = await runCli([...args, "--json"], { env });
    expect(json.code).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report.cases.map((c: { id: string }) => c.id)).toEqual(["exit-codes", "tls"]);
    expect(report.cost.requests).toBe(
      report.cases.reduce((sum: number, c: { requests: number }) => sum + c.requests, 0),
    );
    expect(report.f05).toBe(1);
    expect(report.recall_at_precision_floor.recall).toBe(1);
    expect(report.recall_at_precision_floor.precision_lower_bound).toBe(1);

    const text = await runCli(args, { env });
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/f0\.5 +1\.000/);
    expect(text.stdout).toContain("recall at precision >= 0.9: 100.0%");

    const badJobs = await runCli(["bench", "--cases", cases, "--jobs", "0"], { env });
    expect(badJobs.code).toBe(2);
    expect(badJobs.stderr).toContain("--jobs");
    const badFloor = await runCli(["bench", "--cases", cases, "--precision-floor", "1.5"], { env });
    expect(badFloor.code).toBe(2);
    expect(badFloor.stderr).toContain("--precision-floor");
  });

  test("a cases file without a corpus block and no --root is a usage error", async () => {
    const dir = tempDir("compound-cli-bench-");
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
