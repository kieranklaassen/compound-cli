import { afterAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "../src/errors.ts";
import { headSha, originUrl, writeMissCase } from "../src/eval/add.ts";
import { importJsonSuite, safeId } from "../src/eval/import.ts";
import { loadCases, readQueryFile, redactCitations } from "../src/eval/suite.ts";
import { EXIT } from "../src/exit-codes.ts";
import { startFakeTypeSafe } from "./helpers/fake-typesafe.ts";
import { tempDir, tempRepo } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const BENCH_CASSETTES = resolve(import.meta.dir, "fixtures/cassettes/bench-fixture");
const HOME = tempDir("compound-cli-eval-home-");
const noKey = { HOME };
const judge = startFakeTypeSafe({ noul: 0.9, scoreLevel: 3 });
const withJudge = {
  HOME,
  TYPESAFE_API_KEY: "fake-key-for-the-fake-server",
  TYPESAFE_BASE_URL: judge.url,
};

afterAll(() => judge.stop());

/** The bench fixture's two cases as a JSON suite, the shape `eval import` converts. */
const BENCH_JSON = {
  name: "fixture",
  corpus: null,
  floor: { macro_recall: 1, negatives_correct: 1, precision_lower_bound: 0.9 },
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
      query: { activity: "Rotate the TLS certificate on the load balancer before it expires" },
      expected: [],
      negative: true,
    },
  ],
};

function collection(): { root: string; cases: string } {
  const root = tempDir("compound-cli-eval-");
  const jsonPath = join(root, "fixture.json");
  writeFileSync(jsonPath, JSON.stringify(BENCH_JSON));
  importJsonSuite(jsonPath, {
    out: join(root, "cases", "fixture"),
    cassettes: BENCH_CASSETTES,
    corpus: { path: CORPUS },
  });
  return { root, cases: join(root, "cases") };
}

describe("cases collection format", () => {
  test("a suite.yaml pins the corpus for the cases below it, a case can override it, and nearest wins", () => {
    const root = tempRepo({
      "cases/suite.yaml": "floors:\n  negatives_correct: 1\ncassettes: ../cassettes\n",
      "cases/alpha/suite.yaml": `corpus:\n  git: https://example.test/alpha.git\n  ref: abc123\nfloors:\n  macro_recall: 0.8\n`,
      "cases/alpha/one/query.md": "---\ntags: [dev]\n---\nDo the first thing\n",
      "cases/alpha/one/expect.yaml": "hits: [docs/solutions/a.md]\n",
      "cases/alpha/two/query.md": `---\ncorpus:\n  path: ../../../mirror\n---\nDo the second thing\n`,
      "cases/alpha/two/expect.yaml": "nothing_relevant: true\n",
      "cases/beta/suite.yaml":
        "corpus:\n  path: ../../mirror\nkinds: [pack_rule]\npacks_source: packs\nchannels: [find, suggest]\n",
      "cases/beta/three/query.md": "---\nkind: packs\n---\nAdopt a pack\n",
      "cases/beta/three/expect.yaml": "packs: [tyler-design]\nnear_miss: [kate-bench]\n",
      "cases/beta/four/query.md": "Adversarial work\n",
      "cases/beta/four/expect.yaml": "nothing_relevant: true\nnear_miss: [tyler-design]\n",
      "mirror/.keep": "",
    });
    const { cases, suites } = loadCases(join(root, "cases"));
    expect(cases.map((c) => c.id)).toEqual(["alpha/one", "alpha/two", "beta/four", "beta/three"]);
    const one = cases[0] as (typeof cases)[number];
    expect(one.suite.corpus).toEqual({ git: "https://example.test/alpha.git", ref: "abc123" });
    expect(one.suite.floors).toEqual({ negatives_correct: 1, macro_recall: 0.8 });
    expect(one.suite.cassettes).toBe(join(root, "cassettes"));
    expect(one.channels).toEqual(["find"]);
    expect(one.tags).toEqual(["dev"]);
    const two = cases[1] as (typeof cases)[number];
    expect(two.suite.corpus).toEqual({ path: join(root, "mirror") });
    expect(two.expect.nothing_relevant).toBe(true);
    expect(two.nearMiss).toBe(false);
    const four = cases[2] as (typeof cases)[number];
    expect(four.nearMiss).toBe(true);
    expect(four.channels.sort()).toEqual(["find", "suggest"]);
    const three = cases[3] as (typeof cases)[number];
    expect(three.channels).toEqual(["suggest"]);
    expect(three.suite.kinds).toEqual(["pack_rule"]);
    expect(suites).toHaveLength(3);
  });

  test("a malformed case is a usage error that names the file", () => {
    const missingExpect = tempRepo({
      "cases/suite.yaml": "corpus:\n  path: .\n",
      "cases/x/query.md": "Do a thing\n",
    });
    expect(() => loadCases(join(missingExpect, "cases"))).toThrow(UsageError);
    expect(() => loadCases(join(missingExpect, "cases"))).toThrow(/x: expect.yaml is missing/);
    const emptyExpect = tempRepo({
      "cases/suite.yaml": "corpus:\n  path: .\n",
      "cases/x/query.md": "Do a thing\n",
      "cases/x/expect.yaml": "{}\n",
    });
    expect(() => loadCases(join(emptyExpect, "cases"))).toThrow(/must expect something/);
    const noQuery = tempRepo({
      "cases/suite.yaml": "corpus:\n  path: .\n",
      "cases/x/query.md": "---\ntags: [a]\n---\n",
      "cases/x/expect.yaml": "hits: [a.md]\n",
    });
    expect(() => loadCases(join(noQuery, "cases"))).toThrow(/has no query/);
    const unknownKey = tempRepo({
      "cases/suite.yaml": "corpus:\n  path: .\n",
      "cases/x/query.md": "---\nplann: a.md\n---\nx\n",
      "cases/x/expect.yaml": "hits: [a.md]\n",
    });
    expect(() => loadCases(join(unknownKey, "cases"))).toThrow(/unknown key `plann`/);
    const noCorpus = tempRepo({
      "cases/x/query.md": "Do a thing\n",
      "cases/x/expect.yaml": "hits: [a.md]\n",
    });
    expect(() => loadCases(join(noCorpus, "cases"))).toThrow(/no corpus is pinned/);
    const badPin = tempRepo({ "cases/suite.yaml": "corpus:\n  git: https://x/y.git\n" });
    expect(() => loadCases(join(badPin, "cases"))).toThrow(/needs a ref/);
  });

  test("query.md keeps the activity from the body and citation redaction drops only citing lines", () => {
    const { frontmatter, activity } = readQueryFile(
      "---\nplan: docs/plans/p.md\nredact_citations: true\n---\n<!-- a note -->\nTwo lines of\nactivity text\n",
      "q",
    );
    expect(frontmatter).toEqual({ plan: "docs/plans/p.md", redact_citations: true });
    expect(activity).toBe("Two lines of activity text");
    expect(redactCitations("keep\nsee docs/solutions/x/y.md for why\nalso keep\n")).toBe(
      "keep\n\nalso keep\n",
    );
  });
});

describe("eval import", () => {
  test("a bench JSON becomes case directories, a suite.yaml with the pin and floors, and moved cassettes", () => {
    const { root, cases } = collection();
    const suiteDir = join(cases, "fixture");
    expect(readdirSync(suiteDir).sort()).toEqual(["exit-codes", "suite.yaml", "tls"]);
    const suite = readFileSync(join(suiteDir, "suite.yaml"), "utf8");
    expect(suite).toContain("name: fixture");
    expect(suite).toContain(`path: ${CORPUS}`);
    expect(suite).toContain("precision_lower_bound: 0.9");
    expect(suite).toContain("cassettes: ../../cassettes/fixture");
    expect(readdirSync(join(root, "cassettes", "fixture"))).toHaveLength(4);
    expect(readFileSync(join(suiteDir, "tls", "expect.yaml"), "utf8")).toBe(
      "nothing_relevant: true\n",
    );
    expect(readFileSync(join(suiteDir, "tls", "query.md"), "utf8")).toBe(
      "---\ntags:\n  - negative\n---\nRotate the TLS certificate on the load balancer before it expires\n",
    );
  });

  test("plan pointers at redacted copies become the originals with redact_citations; packs cases keep their packs, near misses, and split", () => {
    const root = tempDir("compound-cli-eval-import-");
    writeFileSync(
      join(root, "cora.json"),
      JSON.stringify({
        name: "cora-heldout",
        cases: [
          {
            id: "2026-01-01-plan",
            query: { plan: "bench/plans/2026-01-01-plan.md" },
            expected: ["docs/solutions/a.md"],
          },
          {
            id: "2026-01-01-plan--title-only",
            query: { activity: "Title" },
            expected: ["docs/solutions/a.md"],
          },
        ],
      }),
    );
    importJsonSuite(join(root, "cora.json"), {
      out: join(root, "cases", "cora"),
      plansFrom: "bench/plans",
      plansTo: "docs/plans",
      corpus: { git: "https://github.com/EveryInc/cora.git", ref: "21c00a5" },
      tags: ["heldout"],
    });
    const plan = readFileSync(join(root, "cases/cora/2026-01-01-plan/query.md"), "utf8");
    expect(plan).toContain("plan: docs/plans/2026-01-01-plan.md");
    expect(plan).toContain("redact_citations: true");
    expect(plan).toContain("- heldout");
    expect(plan).toContain("- plan");
    const title = readFileSync(
      join(root, "cases/cora/2026-01-01-plan--title-only/query.md"),
      "utf8",
    );
    expect(title).toContain("- title-only");
    expect(title.endsWith("---\nTitle\n")).toBe(true);

    writeFileSync(
      join(root, "packs.json"),
      JSON.stringify({
        name: "packs",
        cases: [
          {
            id: "Tyler Compose",
            pack: "tyler-design",
            split: "holdout",
            source: "cora-plan:x.md",
            query: { activity: "Polish the compose window", domains: ["ui"] },
            expected: ["tyler-design/remember.md"],
            expected_packs: ["tyler-design"],
          },
          {
            id: "near-db",
            split: "dev",
            query: { activity: "Benchmark Postgres latency" },
            expected: [],
            expected_packs: [],
            negative: true,
            near_miss: true,
            near_miss_of: ["mike-evals", "kate-bench"],
          },
        ],
      }),
    );
    importJsonSuite(join(root, "packs.json"), {
      out: join(root, "cases", "compound-packs"),
      packs: true,
      corpus: { git: "https://github.com/EveryInc/compound-packs.git", ref: "aa1aef6" },
    });
    expect(safeId("Tyler Compose")).toBe("tyler-compose");
    const q = readFileSync(join(root, "cases/compound-packs/tyler-compose/query.md"), "utf8");
    expect(q).toContain("- heldout");
    expect(q).toContain("- pack:tyler-design");
    expect(q).toContain("source: cora-plan:x.md");
    expect(q).toContain("domains:\n  - ui");
    expect(readFileSync(join(root, "cases/compound-packs/tyler-compose/expect.yaml"), "utf8")).toBe(
      "hits:\n  - tyler-design/remember.md\npacks:\n  - tyler-design\n",
    );
    expect(readFileSync(join(root, "cases/compound-packs/near-db/expect.yaml"), "utf8")).toBe(
      "near_miss:\n  - mike-evals\n  - kate-bench\nnothing_relevant: true\n",
    );
    const suite = readFileSync(join(root, "cases/compound-packs/suite.yaml"), "utf8");
    expect(suite).toContain("kinds:\n  - pack_rule");
    expect(suite).toContain("packs_source: packs");
    expect(suite).toContain("channels:\n  - find\n  - suggest");
    const { cases } = loadCases(join(root, "cases", "compound-packs"));
    expect(cases.find((c) => c.id === "near-db")?.nearMiss).toBe(true);
    expect(cases.find((c) => c.id === "near-db")?.channels.sort()).toEqual(["find", "suggest"]);
  });
});

describe("compound eval", () => {
  test("replays an imported suite from its moved cassettes with no key, reports the table and the floors, and filters by case and tag", async () => {
    const { cases } = collection();
    const json = await runCli(["eval", cases, "--replay", "--json"], { env: noKey });
    expect(json.code).toBe(EXIT.OK);
    const report = JSON.parse(json.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.mode).toBe("eval");
    expect(report.cassette_mode).toBe("replay");
    expect(report.cases.map((c: { id: string; result: string }) => [c.id, c.result])).toEqual([
      ["fixture/exit-codes", "PASS"],
      ["fixture/tls", "PASS"],
    ]);
    expect(report.passed).toBe(2);
    expect(report.find.macro_recall).toBe(1);
    expect(report.find.negatives_correct).toBe(1);
    expect(report.suggest).toBeNull();
    expect(report.floors).toEqual({
      macro_recall: 1,
      negatives_correct: 1,
      precision_lower_bound: 0.9,
    });
    expect(report.floor_failures).toEqual([]);
    expect(report.cost.requests).toBeGreaterThan(0);
    expect(report.corpora[0].solutions).toBeGreaterThan(0);

    const text = await runCli(["eval", cases, "--replay", "--enforce-floor"], { env: noKey });
    expect(text.code).toBe(EXIT.OK);
    expect(text.stdout).toMatch(/^case +kind +result +score +ms +cost +notes/);
    expect(text.stdout).toContain("fixture/exit-codes");
    expect(text.stdout).toContain("totals: 2 cases, 2 passed, 0 failed, find macro recall 100.0%");
    expect(text.stdout).toContain(
      "floors: macro recall 1 ok, negatives correct 1 ok, precision lower bound 0.9 ok",
    );

    const one = await runCli(["eval", cases, "--replay", "--case", "tls", "--json"], {
      env: noKey,
    });
    expect(JSON.parse(one.stdout).cases.map((c: { id: string }) => c.id)).toEqual(["fixture/tls"]);
    const tagged = await runCli(["eval", cases, "--replay", "--tag", "negative", "--json"], {
      env: noKey,
    });
    expect(JSON.parse(tagged.stdout).cases).toHaveLength(1);
    const none = await runCli(["eval", cases, "--replay", "--tag", "nope"], { env: noKey });
    expect(none.code).toBe(EXIT.USAGE);
    expect(none.stderr).toContain("no cases match");
  });

  test("a floor that does not hold fails under --enforce-floor with exit 6; a sweep re-scores without new requests", async () => {
    const { cases } = collection();
    writeFileSync(
      join(cases, "fixture", "suite.yaml"),
      `${readFileSync(join(cases, "fixture", "suite.yaml"), "utf8")}`.replace(
        "precision_lower_bound: 0.9",
        "precision_lower_bound: 1.1",
      ),
    );
    const result = await runCli(
      ["eval", cases, "--replay", "--enforce-floor", "--sweep", "0.3,0.9", "--json"],
      {
        env: noKey,
      },
    );
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stderr).toContain("precision lower bound 1 is below the floor 1.1");
    const report = JSON.parse(result.stdout);
    expect(report.floor_failures).toHaveLength(1);
    expect(report.sweep.map((s: { threshold: number }) => s.threshold)).toEqual([0.3, 0.9]);
    const lenient = await runCli(["eval", cases, "--replay", "--sweep", "0.3"], { env: noKey });
    expect(lenient.code).toBe(EXIT.OK);
    expect(lenient.stdout).toContain(
      "floors: macro recall 1 ok, negatives correct 1 ok, precision lower bound 1.1 FAIL",
    );
  });

  test("live without a key exits 3; a replay with no recording exits 5; a bad path exits 2", async () => {
    const { cases } = collection();
    const live = await runCli(["eval", cases, "--live"], { env: noKey });
    expect(live.code).toBe(EXIT.NOT_CONFIGURED);
    expect(live.stderr).toContain("TYPESAFE_API_KEY");
    const both = await runCli(["eval", cases, "--live", "--replay"], { env: noKey });
    expect(both.code).toBe(EXIT.USAGE);
    writeFileSync(
      join(cases, "fixture", "exit-codes", "query.md"),
      "A wording no cassette has seen\n",
    );
    const miss = await runCli(["eval", cases, "--replay", "--case", "exit-codes"], { env: noKey });
    expect(miss.code).toBe(EXIT.JUDGE_FAILURE);
    const nowhere = await runCli(["eval", join(cases, "nowhere")], { env: noKey });
    expect(nowhere.code).toBe(EXIT.USAGE);
  });

  test("--record writes cassettes the next replay answers from; --max-cost-usd stops the run and marks the rest skipped", async () => {
    const root = tempDir("compound-cli-eval-record-");
    const cases = join(root, "cases");
    for (const [id, activity, expect_] of [
      [
        "one",
        "Give the CLI a distinct exit code when nothing is found",
        "hits: [docs/solutions/cli/exit-codes-for-expected-empty-results.md]",
      ],
      [
        "two",
        "Add retries with backoff to the HTTP client",
        "hits: [docs/solutions/http/retry-with-backoff.md]",
      ],
      ["three", "Rotate the TLS certificate on the load balancer", "nothing_relevant: true"],
    ] as const) {
      mkdirSync(join(cases, "fixture", id), { recursive: true });
      writeFileSync(join(cases, "fixture", id, "query.md"), `${activity}\n`);
      writeFileSync(join(cases, "fixture", id, "expect.yaml"), `${expect_}\n`);
    }
    writeFileSync(
      join(cases, "fixture", "suite.yaml"),
      `corpus:\n  path: ${CORPUS}\ncassettes: ../../cassettes/fixture\n`,
    );
    const recorded = await runCli(["eval", cases, "--record", "--json"], { env: withJudge });
    expect(recorded.code).toBe(EXIT.OK);
    const report = JSON.parse(recorded.stdout);
    expect(report.cassette_mode).toBe("record");
    expect(report.cases).toHaveLength(3);
    const files = readdirSync(join(root, "cassettes", "fixture"));
    expect(files.length).toBeGreaterThan(0);
    // The fake judge says yes to everything, so the negative case fails and the report says which hits.
    const three = report.cases.find((c: { id: string }) => c.id === "fixture/three");
    expect(three.result).toBe("FAIL");
    expect(three.notes[0]).toMatch(/^false hit: /);

    const replayed = await runCli(["eval", cases, "--replay", "--json"], { env: noKey });
    expect(replayed.code).toBe(EXIT.OK);
    expect(JSON.parse(replayed.stdout).cost.requests).toBe(report.cost.requests);

    const capped = await runCli(
      ["eval", cases, "--replay", "--max-cost-usd", "0.0000001", "--json"],
      { env: noKey },
    );
    const cappedReport = JSON.parse(capped.stdout);
    expect(cappedReport.cost_cap).toEqual({ limit_usd: 0.0000001, reached: true });
    expect(cappedReport.skipped).toBe(2);
    expect(cappedReport.cases.filter((c: { result: string }) => c.result === "SKIP")).toHaveLength(
      2,
    );
  });

  test("the cassette pin: --record writes it with both thresholds, a replay at another bar fails the gate, and a missing pin fails a replay", async () => {
    const root = tempDir("compound-cli-eval-pin-");
    const cases = join(root, "cases");
    mkdirSync(join(cases, "fixture", "one"), { recursive: true });
    writeFileSync(
      join(cases, "fixture", "one", "query.md"),
      "Give the CLI a distinct exit code when nothing is found\n",
    );
    writeFileSync(
      join(cases, "fixture", "one", "expect.yaml"),
      "hits: [docs/solutions/cli/exit-codes-for-expected-empty-results.md]\n",
    );
    writeFileSync(
      join(cases, "fixture", "suite.yaml"),
      `corpus:\n  path: ${CORPUS}\ncassettes: ../../cassettes/fixture\nsuggest_threshold: 0.4\n`,
    );
    const recorded = await runCli(["eval", cases, "--record", "--json"], { env: withJudge });
    expect(recorded.code).toBe(EXIT.OK);
    const manifest = JSON.parse(
      readFileSync(join(root, "cassettes", "fixture", "manifest.json"), "utf8"),
    );
    expect(manifest.threshold).toBe(0.6);
    expect(manifest.suggest_threshold).toBe(0.4);
    expect(manifest.model_requested).toBe("jev-latest");

    const same = await runCli(["eval", cases, "--replay", "--enforce-floor", "--json"], {
      env: noKey,
    });
    expect(same.code).toBe(EXIT.OK);
    expect(JSON.parse(same.stdout).pin_failures).toEqual([]);
    const moved = await runCli(
      ["eval", cases, "--replay", "--enforce-floor", "--threshold", "0.5", "--json"],
      {
        env: noKey,
      },
    );
    expect(moved.code).toBe(EXIT.FINDINGS);
    expect(moved.stderr).toContain(
      "cassette pin: fixture: threshold 0.5 differs from the recorded 0.6",
    );
    expect(JSON.parse(moved.stdout).pin_failures).toEqual([
      "fixture: threshold 0.5 differs from the recorded 0.6",
    ]);
    const movedSuggest = await runCli(
      ["eval", cases, "--replay", "--enforce-floor", "--suggest-threshold", "0.7", "--json"],
      { env: noKey },
    );
    expect(movedSuggest.code).toBe(EXIT.FINDINGS);
    expect(movedSuggest.stderr).toContain("suggest threshold 0.7 differs from the recorded 0.4");
    // Without --enforce-floor the pin is a warning, not a failure.
    const lenient = await runCli(["eval", cases, "--replay", "--threshold", "0.5"], { env: noKey });
    expect(lenient.code).toBe(EXIT.OK);
    expect(lenient.stdout).toContain("warning: fixture: threshold 0.5 differs");

    const { root: importedRoot, cases: imported } = collection();
    rmSync(join(importedRoot, "cassettes", "fixture", "manifest.json"));
    const unpinned = await runCli(["eval", imported, "--replay", "--enforce-floor"], {
      env: noKey,
    });
    expect(unpinned.code).toBe(EXIT.FINDINGS);
    expect(unpinned.stderr).toContain("no manifest.json pinning the threshold");
  });

  test("--kind runs only that channel on the cases it selects", async () => {
    const root = tempDir("compound-cli-eval-kind-");
    const cases = join(root, "cases", "packs");
    mkdirSync(join(cases, "both"), { recursive: true });
    writeFileSync(
      join(cases, "both", "query.md"),
      "Split a large change into small pull requests for review\n",
    );
    writeFileSync(
      join(cases, "both", "expect.yaml"),
      "hits: [local-rules/prefer-small-prs.md]\npacks: [local-rules]\n",
    );
    writeFileSync(
      join(cases, "suite.yaml"),
      `corpus:\n  path: ${CORPUS}\nkinds: [pack_rule]\npacks_source: packs\nchannels: [find, suggest]\n`,
    );
    const only = await runCli(
      ["eval", join(root, "cases"), "--live", "--kind", "packs", "--json"],
      { env: withJudge },
    );
    const report = JSON.parse(only.stdout);
    expect(report.cases[0].channels).toEqual(["suggest"]);
    expect(report.cases[0].find).toBeNull();
    expect(report.cases[0].suggest).not.toBeNull();
    expect(report.find).toBeNull();
    const findOnly = await runCli(
      ["eval", join(root, "cases"), "--live", "--kind", "find", "--json"],
      { env: withJudge },
    );
    expect(JSON.parse(findOnly.stdout).cases[0].suggest).toBeNull();
    expect(JSON.parse(findOnly.stdout).cost.requests).toBeGreaterThan(report.cost.requests);
  });

  test("a repository of packs runs the find channel over pack rules and suggest from its own source, with near misses scored apart", async () => {
    const root = tempDir("compound-cli-eval-packs-");
    const cases = join(root, "cases", "packs");
    mkdirSync(join(cases, "small-prs"), { recursive: true });
    writeFileSync(
      join(cases, "small-prs", "query.md"),
      "Split a large change into small pull requests for review\n",
    );
    writeFileSync(
      join(cases, "small-prs", "expect.yaml"),
      "hits: [local-rules/prefer-small-prs.md]\npacks: [local-rules]\nnear_miss: [second-pack]\n",
    );
    mkdirSync(join(cases, "near-billing"), { recursive: true });
    writeFileSync(
      join(cases, "near-billing", "query.md"),
      "Cancel a subscription add-on the plan already covers\n",
    );
    writeFileSync(
      join(cases, "near-billing", "expect.yaml"),
      "nothing_relevant: true\nnear_miss: [second-pack]\n",
    );
    writeFileSync(
      join(cases, "suite.yaml"),
      `corpus:\n  path: ${CORPUS}\nkinds: [pack_rule]\npacks_source: packs\nchannels: [find, suggest]\nfloors:\n  near_miss_correct: 1\n`,
    );
    const result = await runCli(
      ["eval", join(root, "cases"), "--live", "--json", "--enforce-floor"],
      {
        env: withJudge,
      },
    );
    const report = JSON.parse(result.stdout);
    const small = report.cases.find((c: { id: string }) => c.id === "packs/small-prs");
    expect(small.channels.sort()).toEqual(["find", "suggest"]);
    expect(small.find.hits.every((h: string) => !h.startsWith("docs/"))).toBe(true);
    expect(small.find.found).toEqual(["local-rules/prefer-small-prs.md"]);
    expect(small.suggest.proposed).toContain("local-rules");
    // The fake judge proposes every pack, so the near miss surfaces and the case fails on it.
    expect(small.near_miss_hits).toContain("second-pack");
    expect(small.result).toBe("FAIL");
    const near = report.cases.find((c: { id: string }) => c.id === "packs/near-billing");
    expect(near.result).toBe("FAIL");
    expect(report.near_miss_correct).toBe(0);
    // Near misses never count as clear negatives.
    expect(report.find.negative_cases).toBe(0);
    expect(report.suggest.negative_cases).toBe(0);
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(result.stderr).toContain("near miss correct 0 is below the floor 1");
  });
});

describe("eval add --miss", () => {
  test("writes a case pinned to the repository's origin and HEAD, with the token stripped from the URL", () => {
    const repo = tempRepo({
      "docs/solutions/a.md": "# a\n",
      "docs/plans/p.md": "# p\nsee docs/solutions/a.md\n",
    });
    execSync(
      "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init && git remote add origin https://x-access-token:secret@github.com/acme/repo.git",
      { cwd: repo },
    );
    expect(originUrl(repo)).toBe("https://github.com/acme/repo.git");
    const sha = headSha(repo) as string;
    const out = tempDir("compound-cli-eval-add-");
    const written = writeMissCase(
      {
        id: "Missed A",
        activity: "Do the thing the plan describes",
        concepts: ["c"],
        decisions: [],
        domains: [],
        modules: [],
        paths: [],
        plan: "docs/plans/p.md",
        redactCitations: true,
        hits: ["docs/solutions/a.md"],
        packs: [],
        nearMiss: [],
        note: "the plan re-derived it",
        tags: ["plan"],
        repoRoot: repo,
        docsRoot: "docs",
      },
      out,
    );
    expect(written.dir).toBe(join(out, "missed-a"));
    expect(written.corpus).toEqual({ git: "https://github.com/acme/repo.git", ref: sha });
    const query = readFileSync(join(out, "missed-a", "query.md"), "utf8");
    expect(query).not.toContain("secret");
    expect(query).toContain(`ref: ${sha}`);
    expect(query).toContain("plan: docs/plans/p.md");
    expect(query).toContain("redact_citations: true");
    expect(query).toContain("- miss\n  - plan");
    expect(query.endsWith("---\nDo the thing the plan describes\n")).toBe(true);
    expect(readFileSync(join(out, "missed-a", "expect.yaml"), "utf8")).toBe(
      "hits:\n  - docs/solutions/a.md\n",
    );
    // The case loads as a collection of one, pinned by itself.
    const { cases } = loadCases(out);
    expect(cases[0]?.suite.corpus?.ref).toBe(sha);
    expect(cases[0]?.channels).toEqual(["find"]);
    expect(() => writeMissCase({ ...base(repo), hits: [], note: "n" }, out)).toThrow(
      /names what should have surfaced/,
    );
    expect(() => writeMissCase({ ...base(repo), note: "  " }, out)).toThrow(/--note/);
    expect(() => writeMissCase({ ...base(repo), id: "Missed A" }, out)).toThrow(/exists/);
  });

  test("the CLI form writes the same case and refuses without --miss", async () => {
    const repo = tempRepo({ "docs/solutions/a.md": "# a\n" });
    execSync(
      "git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m init && git remote add origin https://github.com/acme/repo.git",
      { cwd: repo },
    );
    const out = tempDir("compound-cli-eval-add-cli-");
    const result = await runCli(
      [
        "eval",
        "add",
        "--miss",
        "--root",
        repo,
        "--out",
        out,
        "--id",
        "from-cli",
        "--expect",
        "docs/solutions/a.md",
        "--note",
        "missed",
        "Do the thing",
      ],
      { env: noKey },
    );
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("wrote");
    expect(existsSync(join(out, "from-cli", "expect.yaml"))).toBe(true);
    const refused = await runCli(["eval", "add", "--root", repo, "--out", out, "--id", "x"], {
      env: noKey,
    });
    expect(refused.code).toBe(EXIT.USAGE);
  });
});

describe("bench is deprecated", () => {
  test("bench --cases still runs and says what to do instead", async () => {
    const dir = tempDir("compound-cli-bench-dep-");
    writeFileSync(join(dir, "cases.json"), JSON.stringify(BENCH_JSON));
    const cassettes = join(dir, "cassettes");
    cpSync(BENCH_CASSETTES, cassettes, { recursive: true });
    const result = await runCli(
      ["bench", "--cases", join(dir, "cases.json"), "--root", CORPUS, "--json"],
      {
        env: { HOME, COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: cassettes },
      },
    );
    expect(result.code).toBe(EXIT.OK);
    expect(result.stderr).toContain("deprecated");
    expect(result.stderr).toContain("compound eval import");
  });
});

function base(repo: string) {
  return {
    id: "another",
    concepts: [],
    decisions: [],
    domains: [],
    modules: [],
    paths: [],
    redactCitations: false,
    hits: ["docs/solutions/a.md"],
    packs: [],
    nearMiss: [],
    note: "n",
    tags: [],
    repoRoot: repo,
    docsRoot: "docs",
  };
}
