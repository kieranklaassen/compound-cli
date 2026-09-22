import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "../src/exit-codes.ts";
import { startFakeTypeSafe } from "./helpers/fake-typesafe.ts";
import { tempDir } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

/**
 * Every documented option of the v1 command set, driven end to end through the
 * binary against a fake judge. This proves the flags parse, reach the run, and
 * show up in the output; relevance is the bench's job.
 */

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const INPUT = resolve(import.meta.dir, "fixtures/input");
const judge = startFakeTypeSafe({ noul: 0.9, scoreLevel: 3 });
const env = {
  HOME: tempDir("compound-cli-home-"),
  TYPESAFE_API_KEY: "fake-key-for-the-fake-server",
  TYPESAFE_BASE_URL: judge.url,
  CE_PACKS_GIT_TIMEOUT: "1",
};
const ACTIVITY = "Give the CLI a distinct exit code when a lookup finds nothing";

afterAll(() => judge.stop());

describe("find: every documented option", () => {
  test("channels, judge settings, and filters all reach the run and the JSON", async () => {
    const result = await runCli(
      [
        "find",
        ACTIVITY,
        "--concept",
        "exit codes",
        "--decision",
        "distinct code for empty",
        "--domain",
        "cli",
        "--module",
        "runner",
        "--path",
        "src/cli.ts",
        "--diff",
        join(INPUT, "sample.diff"),
        "--plan",
        join(INPUT, "plan.md"),
        "--threshold",
        "0.4",
        "--tier-one-threshold",
        "0.2",
        "--batch",
        "3",
        "--parallel",
        "2",
        "--candidate-cap",
        "5",
        "--excerpt-chars",
        "1200",
        "--model",
        "jev-latest",
        "--kind",
        "solution",
        "--problem-type",
        "best_practice",
        "--module-filter",
        "cli",
        "--tag",
        "exit-codes",
        "--no-sources",
        "--json",
        "--root",
        CORPUS,
      ],
      { env },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.state.concepts).toEqual(["exit codes"]);
    expect(report.state.decisions).toEqual(["distinct code for empty"]);
    expect(report.state.domains).toEqual(["cli"]);
    expect(report.state.modules).toEqual(["runner"]);
    expect(report.state.paths).toEqual(["src/cli.ts"]);
    expect(report.state.diff.files.length).toBeGreaterThan(0);
    expect(report.state.plan.title).toBe("Retry budget");
    expect(report.state.plan.text_truncated).toBe(false);
    expect(report.state.plan.text).toBeUndefined();
    expect(report.threshold).toBe(0.4);
    expect(report.tier_one_threshold).toBe(0.2);
    expect(report.corpus.candidate_cap).toBe(5);
    expect(report.corpus.pack_candidates).toBe(0);
    expect(report.corpus.filtered_out.total).toBeGreaterThan(0);
    expect(report.hits.every((h: { kind: string }) => h.kind === "solution")).toBe(true);
    expect(report.hits.map((h: { path: string }) => h.path)).toContain(
      "docs/solutions/cli/exit-codes-for-expected-empty-results.md",
    );
  });

  test("--gate answers with one score, --frontmatter-only skips tier two at the tier-one bar, --compact renders rows", async () => {
    const gate = await runCli(
      ["find", "--gate", ACTIVITY, "--json", "--no-sources", "--root", CORPUS],
      { env },
    );
    expect(gate.code).toBe(EXIT.OK);
    const gated = JSON.parse(gate.stdout);
    expect(gated.mode).toBe("gate");
    expect(gated.gate.probability).toBeGreaterThan(0);
    expect(gated.gate.threshold).toBe(0.6);
    expect(gated.gate.hits).toBe(gated.hits.length);

    const before = judge.requests();
    const fm = await runCli(
      ["find", ACTIVITY, "--frontmatter-only", "--json", "--no-sources", "--root", CORPUS],
      { env },
    );
    expect(fm.code).toBe(EXIT.OK);
    const fmReport = JSON.parse(fm.stdout);
    expect(fmReport.frontmatter_only).toBe(true);
    expect(fmReport.threshold).toBe(0.5);
    expect(fmReport.corpus.tier_two_judged).toBe(0);
    expect(judge.requests() - before).toBeLessThanOrEqual(2);

    const compact = await runCli(
      ["find", ACTIVITY, "--compact", "--no-sources", "--root", CORPUS],
      { env },
    );
    expect(compact.code).toBe(EXIT.OK);
    expect(compact.stdout).toMatch(/^docs\/solutions\/.*\t\d\.\d\d\tsolution\t/m);
    expect(compact.stdout).toMatch(/^# hits=\d+ nothing_relevant=(true|false) threshold=0\.6/m);
  });

  test("--overlap --doc judges a draft against the corpus on five dimensions", async () => {
    const result = await runCli(
      [
        "find",
        "--overlap",
        "--doc",
        join(INPUT, "draft-learning.md"),
        "--json",
        "--no-sources",
        "--root",
        CORPUS,
      ],
      { env },
    );
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe("overlap");
    expect(report.state.doc.title.length).toBeGreaterThan(0);
    expect(report.hits.length).toBeGreaterThan(0);
    const overlap = report.hits[0].overlap;
    for (const dimension of ["problem", "root_cause", "solution", "files", "prevention"]) {
      expect(typeof overlap[dimension]).toBe("number");
    }
  });

  test("a diff on stdin, a pack filter with no packs, and usage errors for bad values", async () => {
    const stdin = await runCli(
      ["find", ACTIVITY, "--diff", "-", "--json", "--no-sources", "--root", CORPUS],
      {
        env,
        stdin: readFileSync(join(INPUT, "sample.diff"), "utf8"),
      },
    );
    expect(stdin.code).toBe(EXIT.OK);
    expect(JSON.parse(stdin.stdout).state.diff.files.length).toBeGreaterThan(0);

    const pack = await runCli(
      ["find", ACTIVITY, "--pack", "nope", "--json", "--no-sources", "--root", CORPUS],
      { env },
    );
    expect(pack.code).toBe(EXIT.OK);
    expect(JSON.parse(pack.stdout).hits).toEqual([]);

    for (const bad of [
      ["--threshold", "2"],
      ["--batch", "0"],
      ["--parallel", "x"],
      ["--candidate-cap", "-1"],
      ["--excerpt-chars", "0"],
      ["--kind", "book"],
    ]) {
      const result = await runCli(["find", ACTIVITY, ...bad, "--root", CORPUS], { env });
      expect(result.code).toBe(EXIT.USAGE);
      expect(result.stderr).toContain(bad[0] as string);
    }
    const noInput = await runCli(["find", "--root", CORPUS], { env });
    expect(noInput.code).toBe(EXIT.USAGE);
  });
});

describe("packs, bench, doctor, version: every documented option", () => {
  test("packs resolve and list read the declaration; packs add writes it; packs suggest honors --threshold and --refresh", async () => {
    const root = tempDir("compound-cli-packs-");
    writeFileSync(join(root, "README.md"), "# t\n");
    const resolved = await runCli(["packs", "resolve", "--json", "--root", root], { env });
    expect(resolved.code).toBe(EXIT.OK);
    expect(JSON.parse(resolved.stdout).entries).toBe(0);
    const listed = await runCli(["packs", "list", "--root", root], { env });
    expect(listed.code).toBe(EXIT.OK);
    expect(listed.stdout).toContain("No packs declared");

    const added = await runCli(["packs", "add", "kieran-engineering", "--yes", "--root", root], {
      env: { ...env, CE_PACKS_CACHE_ROOT: tempDir("compound-cli-cache-") },
    });
    // The success path runs against a seeded cache in pack-sources.test.ts; here no source is
    // reachable, so the answer is a usage error naming the pack, never a write.
    expect(added.code).toBe(EXIT.USAGE);
    expect(added.stderr).toContain(
      'no known source publishes an undeclared pack "kieran-engineering"',
    );
    expect(existsSync(join(root, ".compound-engineering/config.yaml"))).toBe(false);

    const suggest = await runCli(
      [
        "packs",
        "suggest",
        ACTIVITY,
        "--threshold",
        "0.99",
        "--refresh",
        "--model",
        "jev-latest",
        "--json",
        "--root",
        root,
      ],
      {
        env: { ...env, CE_PACKS_CACHE_ROOT: tempDir("compound-cli-cache-") },
      },
    );
    expect(suggest.code).toBe(EXIT.OK);
    const suggested = JSON.parse(suggest.stdout);
    expect(suggested.threshold).toBe(0.99);
    expect(suggested.suggestions).toEqual([]);
  });

  test("bench --only, --out, --threshold, --frontmatter-only, --sweep, --model work together", async () => {
    const dir = tempDir("compound-cli-bench-");
    const cases = join(dir, "cases.json");
    const out = join(dir, "out", "report.json");
    writeFileSync(
      cases,
      JSON.stringify({
        name: "surface",
        corpus: null,
        cases: [
          {
            id: "hit",
            query: { activity: ACTIVITY },
            expected: ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
          },
          {
            id: "skipped",
            query: { activity: "never runs" },
            expected: ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
          },
        ],
      }),
    );
    const result = await runCli(
      [
        "bench",
        "--cases",
        cases,
        "--root",
        CORPUS,
        "--only",
        "hit",
        "--out",
        out,
        "--threshold",
        "0.5",
        "--frontmatter-only",
        "--sweep",
        "0.2,0.9",
        "--model",
        "jev-latest",
        "--json",
      ],
      { env },
    );
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.cases.map((c: { id: string }) => c.id)).toEqual(["hit"]);
    expect(report.threshold).toBe(0.5);
    expect(report.sweep.map((s: { threshold: number }) => s.threshold)).toEqual([0.2, 0.9]);
    expect(report.model).toBe("jev-fake");
    expect(JSON.parse(readFileSync(out, "utf8")).name).toBe("surface");
  });

  test("doctor --json and --no-sources report the corpus, --strict exits 3 without a key; version prints the version", async () => {
    const root = tempDir("compound-cli-doctor-");
    writeFileSync(join(root, "README.md"), "# t\n");
    const broken = join(root, "docs/solutions");
    Bun.spawnSync(["mkdir", "-p", broken]);
    writeFileSync(join(broken, "bad.md"), "---\ntitle: [unclosed\n---\nbody\n");
    const lenient = await runCli(["doctor", "--no-sources", "--root", root], { env });
    expect(lenient.code).toBe(EXIT.OK);
    expect(lenient.stdout).toContain("malformed frontmatter: 1");
    const json = await runCli(["doctor", "--json", "--no-sources", "--strict", "--root", root], {
      env,
    });
    expect(json.code).toBe(EXIT.OK);
    expect(JSON.parse(json.stdout).key.present).toBe(true);
    const strict = await runCli(["doctor", "--strict", "--no-sources", "--root", root], {
      env: { HOME: env.HOME },
    });
    expect(strict.code).toBe(EXIT.NOT_CONFIGURED);

    const version = await runCli(["version"], { env });
    expect(version.code).toBe(EXIT.OK);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
