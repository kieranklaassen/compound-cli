import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { FindResult, Hit } from "../src/find/result.ts";
import { renderCompact } from "../src/output/compact.ts";
import { renderJson } from "../src/output/json.ts";
import { renderReport } from "../src/output/report.ts";
import { runCli } from "./helpers/run-cli.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const CASSETTES = resolve(import.meta.dir, "fixtures/cassettes/find");

const EXPECTED_TOP_LEVEL = [
  "corpus",
  "frontmatter_only",
  "gate",
  "hits",
  "mode",
  "nothing_relevant",
  "schema_version",
  "state",
  "suggest_threshold",
  "threshold",
  "tier_one_threshold",
  "usage",
  "warnings",
];

const EXPECTED_HIT_KEYS = [
  "declaration",
  "frontmatter",
  "kind",
  "matched_fields",
  "overlap",
  "pack_id",
  "pack_path",
  "passage",
  "path",
  "score",
  "tier_one_score",
  "title",
];

function hit(overrides: Partial<Hit>): Hit {
  return {
    path: "docs/solutions/a.md",
    kind: "solution",
    score: 0.91,
    tier_one_score: 0.88,
    pack_id: null,
    pack_path: null,
    title: "A",
    frontmatter: { title: "A" },
    passage: {
      heading: "Rule",
      start_line: 12,
      end_line: 20,
      text: "Do the thing.\nThen the other.",
      probability: 0.7,
    },
    matched_fields: ["title"],
    declaration: null,
    overlap: null,
    ...overrides,
  };
}

function result(hits: Hit[], overrides: Partial<FindResult> = {}): FindResult {
  return {
    schema_version: 1,
    mode: "find",
    state: {
      activity: "x",
      concepts: [],
      decisions: [],
      domains: [],
      modules: [],
      paths: [],
      diff: null,
      plan: null,
      doc: null,
      keywords: ["x"],
    },
    hits,
    nothing_relevant: hits.length === 0,
    threshold: 0.5,
    suggest_threshold: 0.5,
    tier_one_threshold: 0.3,
    frontmatter_only: false,
    gate: null,
    usage: {
      requests: 3,
      input_tokens: 4500,
      output_tokens: 20,
      estimated_usd: 0.000189,
      wall_ms: 1234,
      model: "jev-1.13.0",
    },
    corpus: {
      solutions: 7,
      pack_rules: 2,
      pack_candidates: 0,
      judged: 9,
      tier_two_judged: 2,
      prefilter_dropped: 0,
      prefilter_dropped_protected: 0,
      candidate_cap: 400,
      filtered_out: {
        by_kind: 0,
        by_problem_type: 0,
        by_module: 0,
        by_tag: 0,
        by_pack: 0,
        total: 0,
      },
    },
    warnings: [],
    ...overrides,
  };
}

describe("renderJson", () => {
  test("carries every documented top-level and hit field", () => {
    const json = JSON.parse(
      renderJson(
        result([
          hit({}),
          hit({
            path: "local-rules/r.md",
            kind: "pack_rule",
            pack_id: "local-rules",
            pack_path: "r.md",
            score: 0.6,
          }),
        ]),
      ),
    );
    expect(Object.keys(json).sort()).toEqual(EXPECTED_TOP_LEVEL);
    expect(Object.keys(json.hits[0]).sort()).toEqual(EXPECTED_HIT_KEYS);
    expect(json.schema_version).toBe(1);
    expect(json.hits[1].pack_id).toBe("local-rules");
  });

  test("a nothing_relevant result has an empty hits array and the flag", () => {
    const json = JSON.parse(renderJson(result([])));
    expect(json.hits).toEqual([]);
    expect(json.nothing_relevant).toBe(true);
  });
});

describe("renderCompact", () => {
  test("one row per hit in descending score, then a # trailer", () => {
    const text = renderCompact(
      result([hit({ score: 0.91 }), hit({ path: "b.md", score: 0.55, passage: null })]),
    );
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("docs/solutions/a.md\t0.91\tsolution\t-\t12-20");
    expect(lines[1]).toBe("b.md\t0.55\tsolution\t-\t-");
    expect(lines[2]?.startsWith("# hits=2 nothing_relevant=false")).toBe(true);
    expect(lines[2]).toContain("usd=0.000189");
  });

  test("a gate result adds gate= to the trailer", () => {
    const text = renderCompact(
      result([], { mode: "gate", gate: { probability: 0.12, threshold: 0.5, hits: 0 } }),
    );
    expect(text).toContain("gate=0.12");
  });
});

describe("renderReport", () => {
  test("says nothing relevant plainly", () => {
    expect(renderReport(result([]))).toContain("nothing relevant");
  });

  test("shows the passage and matched fields for a hit", () => {
    const text = renderReport(result([hit({})]));
    expect(text).toContain("0.91  docs/solutions/a.md");
    expect(text).toContain("passage: Rule (lines 12-20)");
    expect(text).toContain("> Do the thing.");
    expect(text).toContain("matched: title");
  });
});

describe("compound find end to end in replay", () => {
  test("--json returns schema version 1 with hits and exits 0", async () => {
    const run = await runCli(
      [
        "find",
        "Give the CLI a distinct exit code when a lookup finds nothing, so callers can tell it from a crash",
        "--json",
        "--no-sources",
        "--root",
        CORPUS,
      ],
      {
        env: { COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: `${CASSETTES}/exit-codes` },
      },
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const json = JSON.parse(run.stdout);
    expect(json.schema_version).toBe(1);
    expect(json.hits[0].path).toBe("docs/solutions/cli/exit-codes-for-expected-empty-results.md");
    expect(json.state.activity).toContain("distinct exit code");
    expect(json.nothing_relevant).toBe(false);
  });

  test("--compact returns rows and a trailer; nothing relevant still exits 0", async () => {
    const run = await runCli(
      [
        "find",
        "Rotate the TLS certificate on the load balancer before it expires",
        "--compact",
        "--no-sources",
        "--root",
        CORPUS,
      ],
      { env: { COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: `${CASSETTES}/tls` } },
    );
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^# hits=0 nothing_relevant=true/);
  });

  test("a cassette miss is exit 5 with a message naming the recording", async () => {
    const run = await runCli(
      ["find", "something never recorded", "--json", "--no-sources", "--root", CORPUS],
      {
        env: { COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: `${CASSETTES}/tls` },
      },
    );
    expect(run.code).toBe(5);
    expect(run.stderr).toContain("cassette replay miss");
  });
});
