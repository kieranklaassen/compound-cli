import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "../src/exit-codes.ts";
import { DEFAULTS } from "../src/find/defaults.ts";
import { startFakeTypeSafe } from "./helpers/fake-typesafe.ts";
import { tempDir, tempRepo } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

/**
 * The manual robustness pass, automated: a clean environment with and without
 * a key, an empty corpus, a corpus of malformed files, a corpus far above the
 * candidate cap, and a git checkout with no build. Judging goes to a fake
 * TypeSafe server so none of this needs a key, a network, or a recording.
 */

const REPO = resolve(import.meta.dir, "..");
const EMPTY_HOME = tempDir("compound-cli-home-");
const judge = startFakeTypeSafe({ noul: 0.1, scoreLevel: 0 });
const created: string[] = [EMPTY_HOME];

afterAll(() => {
  judge.stop();
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = tempRepo(files);
  created.push(root);
  return root;
}

const withJudge = {
  HOME: EMPTY_HOME,
  TYPESAFE_API_KEY: "fake-key-for-the-fake-server",
  TYPESAFE_BASE_URL: judge.url,
  CE_PACKS_GIT_TIMEOUT: "1",
};

const ACTIVITY = "Give the CLI a distinct exit code when a lookup finds nothing";

describe("clean environment", () => {
  test("without a key every judging command exits 3 before reading the corpus, and --json still gets the line on stderr", async () => {
    const root = repo({
      "docs/solutions/a.md": "---\ntitle: A\n---\n# A\n",
      "cases.json": JSON.stringify({
        name: "t",
        corpus: null,
        cases: [{ id: "a", query: { activity: ACTIVITY }, expected: [], negative: true }],
      }),
    });
    for (const args of [
      ["find", ACTIVITY],
      ["find", ACTIVITY, "--json"],
      ["packs", "suggest", ACTIVITY],
      ["bench", "--cases", join(root, "cases.json")],
    ]) {
      const result = await runCli([...args, "--root", root], { env: { HOME: EMPTY_HOME } });
      expect(result.code).toBe(EXIT.NOT_CONFIGURED);
      expect(result.stderr).toContain("TYPESAFE_API_KEY");
      expect(result.stdout).toBe("");
    }
  });

  test("help, doctor, and packs list work without a key", async () => {
    const root = repo({ "docs/solutions/a.md": "---\ntitle: A\ndate: 2026-01-01\n---\n# A\n" });
    const help = await runCli(["--help"], { env: { HOME: EMPTY_HOME } });
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain("compound 0.1.0");
    const doctor = await runCli(["doctor", "--root", root], { env: { HOME: EMPTY_HOME } });
    expect(doctor.code).toBe(EXIT.OK);
    expect(doctor.stdout).toContain("TYPESAFE_API_KEY: missing");
    const packs = await runCli(["packs", "list", "--root", root], { env: { HOME: EMPTY_HOME } });
    expect(packs.code).toBe(EXIT.OK);
    expect(packs.stdout).toContain("No packs declared");
  });
});

describe("corpus shapes", () => {
  test("an empty docs/solutions is nothing relevant with zero requests and the count visible in JSON", async () => {
    const root = repo({ "docs/solutions/.keep": "" });
    const result = await runCli(["find", ACTIVITY, "--json", "--root", root], { env: withJudge });
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.nothing_relevant).toBe(true);
    expect(report.corpus.solutions).toBe(0);
    expect(report.usage.requests).toBe(0);
  });

  test("no docs directory at all is a missing corpus, exit 4", async () => {
    const root = repo({ "README.md": "nothing here\n" });
    const result = await runCli(["find", ACTIVITY, "--root", root], { env: withJudge });
    expect(result.code).toBe(EXIT.MISSING_CORPUS);
    expect(result.stderr).toContain("missing corpus");
  });

  test("malformed files are skipped with a warning each, lenient ones load, and doctor lists them", async () => {
    const root = repo({
      "docs/solutions/good.md":
        '---\ntitle: A good learning about retry backoff\ndate: 2026-01-01\napplies_when:\n  - "Adding retry with backoff to an HTTP client"\n---\n# Good\n\n## Rule\nRetry with jittered exponential backoff.\n',
      "docs/solutions/broken-yaml.md":
        "---\ntitle: [unclosed\ndate: 2026-01-01\ntags: {a: b\n---\n# Broken\nbody\n",
      "docs/solutions/unterminated.md":
        "---\ntitle: Never closes\ndate: 2026-01-01\n# Heading inside frontmatter\nbody text\n",
      "docs/solutions/dupe-keys.md": "---\ntitle: one\ntitle: two\n---\nbody\n",
      "docs/solutions/empty.md": "",
      "docs/solutions/frontmatter-only.md": "---\ntitle: Only frontmatter\ndate: 2026-01-01\n---\n",
      "docs/solutions/tags-scalar.md":
        '---\ntitle: Tags as scalar\ndate: not-a-date\ntags: single\napplies_when: "scalar not list"\nmodule: 42\n---\n# T\nbody\n',
      "docs/solutions/huge.md": `---\ntitle: Huge body about retry backoff\ndate: 2026-01-01\n---\n# Huge\n${"retry backoff ".repeat(200_000)}`,
      "docs/solutions/dir.md/.keep": "",
    });
    writeFileSync(
      join(root, "docs/solutions/binary.md"),
      Buffer.concat([
        Buffer.from("---\ntitle: bin\n---\n"),
        Buffer.from([0, 255, 254, 0]),
        Buffer.alloc(2048, 0x9f),
      ]),
    );
    symlinkSync("loop", join(root, "docs/solutions/loop"));

    const result = await runCli(
      ["find", "Adding retry with backoff to the HTTP client", "--json", "--root", root],
      { env: withJudge },
    );
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.corpus.solutions).toBe(6);
    const skipped = report.warnings.filter((w: string) => w.startsWith("skipped docs/solutions/"));
    expect(skipped).toHaveLength(3);
    expect(skipped.join("\n")).toContain("broken-yaml.md");
    expect(skipped.join("\n")).toContain("unterminated.md");
    expect(skipped.join("\n")).toContain("dupe-keys.md");

    const doctor = await runCli(["doctor", "--root", root], { env: { HOME: EMPTY_HOME } });
    expect(doctor.code).toBe(EXIT.OK);
    expect(doctor.stdout).toContain("malformed frontmatter: 3");
  });

  test("a corpus far above the cap judges only the cap, keeps the keyword matches, and says what was cut", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      files[`docs/solutions/area${i % 20}/learning-${i}.md`] =
        `---\ntitle: Filler learning ${i} about queue workers\ndate: 2026-01-01\napplies_when:\n  - "Working on queue worker ${i}"\n---\n# Filler ${i}\n\n## Problem\nSomething ${i}.\n`;
    }
    files["docs/solutions/needle.md"] =
      '---\ntitle: Give agent-facing CLIs a distinct exit code for an expected empty result\ndate: 2026-05-01\napplies_when:\n  - "Adding or changing exit codes in a command-line tool"\n---\n# Distinct exit code\n\n## Rule\nAn absent artifact is not an error.\n';
    const root = repo(files);
    const before = judge.requests();
    const result = await runCli(["find", ACTIVITY, "--json", "--root", root], { env: withJudge });
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.corpus.solutions).toBe(1001);
    expect(report.corpus.judged).toBe(DEFAULTS.candidateCap);
    expect(report.corpus.prefilter_dropped).toBe(1001 - DEFAULTS.candidateCap);
    expect(report.warnings.join("\n")).toContain("raise --candidate-cap above 400");
    expect(report.corpus.prefilter_dropped_protected).toBe(601);
    expect(report.corpus.candidate_cap).toBe(400);
    // Tier one on 400 candidates is at most ceil(400 / batch) requests; the fake judge passes nothing to tier two.
    expect(judge.requests() - before).toBeLessThanOrEqual(
      Math.ceil(DEFAULTS.candidateCap / DEFAULTS.batch),
    );
  });
});

describe("running from a git checkout without a build", () => {
  const checkout = tempDir("compound-cli-checkout-");
  created.push(checkout);
  const archive = spawnSync("git", ["archive", "HEAD"], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  expect(archive.status).toBe(0);
  const extract = spawnSync("tar", ["-x", "-C", checkout], { input: archive.stdout });
  expect(extract.status).toBe(0);
  symlinkSync(join(REPO, "node_modules"), join(checkout, "node_modules"));

  test("the shim runs the TypeScript source under Bun, which is what bunx --bun github:... does", () => {
    const result = spawnSync("bun", ["bin/compound.js", "--help"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, HOME: EMPTY_HOME },
    });
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("compound 0.1.0");
  });

  test("under Node without dist/ the shim exits 1 with the build instruction instead of a dangling bin", () => {
    const result = spawnSync("node", ["bin/compound.js", "--help"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, HOME: EMPTY_HOME },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no dist/ build");
    expect(result.stderr).toContain("bunx --bun github:kieranklaassen/compound-cli");
  });

  test("a build makes the same shim run under Node", () => {
    const build = spawnSync("bun", ["run", "build"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, HOME: EMPTY_HOME },
    });
    expect(build.status).toBe(0);
    const result = spawnSync("node", ["bin/compound.js", "--help"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, HOME: EMPTY_HOME },
    });
    expect(result.status).toBe(EXIT.OK);
    expect(result.stdout).toContain("compound 0.1.0");
  });
});

describe("temp hygiene", () => {
  test("the test suite's temp directories carry the compound-cli prefix so a leak is attributable", () => {
    mkdirSync(join(EMPTY_HOME, ".probe"), { recursive: true });
    expect(EMPTY_HOME).toContain("compound-cli-");
  });
});
