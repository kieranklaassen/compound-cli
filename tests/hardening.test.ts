import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendPackEntry, renderEntry } from "../src/commands/packs-add.ts";
import { loadCeConfig } from "../src/config/ce-config.ts";
import { cacheKey, createGitCache, type GitCache } from "../src/corpus/git-cache.ts";
import { loadLearnings } from "../src/corpus/learnings.ts";
import { EVERY_SOURCE, loadPackCandidates } from "../src/corpus/pack-sources.ts";
import { loadPackRules, resolvePacks } from "../src/corpus/packs.ts";
import { EXIT } from "../src/exit-codes.ts";
import { DEFAULTS } from "../src/find/defaults.ts";
import { applyFilters, NO_FILTERS } from "../src/find/filters.ts";
import { parseUnifiedDiff } from "../src/input/diff.ts";
import { buildWorkState } from "../src/input/work-state.ts";
import { fakeContext, NO_CHANNELS, tempRepo } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const CASSETTES = resolve(import.meta.dir, "fixtures/cassettes");
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "compound-cli-home-"));
const RULE = (title: string) =>
  `---\ntitle: "${title}"\napplies_when:\n  - "Always"\n---\n\n# ${title}\n`;

/** A cache root where the built-in git source counts as cached and empty, so no clone is attempted. */
function seededCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "compound-cli-cache-"));
  mkdirSync(join(root, cacheKey(EVERY_SOURCE, "main"), "packs"), { recursive: true });
  return root;
}

describe("frontmatter filters", () => {
  const config = loadCeConfig(CORPUS);
  const learnings = loadLearnings(CORPUS, config.docsRootAbs).candidates;
  const rules = loadPackRules(resolvePacks(config, createGitCache({})).roots).candidates;
  const all = [...learnings, ...rules];

  test("--tag matches case-insensitively and counts removals", () => {
    const { kept, filteredOut } = applyFilters(all, { ...NO_FILTERS, tags: ["Exit-Codes"] });
    expect(kept.map((c) => c.path)).toEqual([
      "docs/solutions/cli/exit-codes-for-expected-empty-results.md",
    ]);
    expect(filteredOut.by_tag).toBe(all.length - 1);
    expect(filteredOut.total).toBe(all.length - 1);
  });

  test("--pack keeps only that pack's rules and drops every learning", () => {
    const { kept, filteredOut } = applyFilters(all, { ...NO_FILTERS, packs: ["local-rules"] });
    expect(kept).toHaveLength(2);
    expect(kept.every((c) => c.packId === "local-rules")).toBe(true);
    expect(filteredOut.by_pack).toBe(learnings.length);
  });

  test("--problem-type and --module-filter match by substring, and each candidate is counted once", () => {
    const byType = applyFilters(all, { ...NO_FILTERS, problemTypes: ["CONVENTION"] });
    expect(byType.kept.map((c) => c.path)).toEqual([
      "docs/solutions/frontend/inertia-react-package-alignment.md",
    ]);
    const combined = applyFilters(all, { ...NO_FILTERS, kinds: ["solution"], modules: ["http"] });
    expect(combined.kept.map((c) => c.path)).toEqual([
      "docs/solutions/http/retry-with-backoff-honoring-retry-after.md",
    ]);
    expect(combined.filteredOut.by_kind).toBe(rules.length);
    expect(combined.filteredOut.by_module).toBe(learnings.length - 1);
    expect(combined.filteredOut.total).toBe(
      combined.filteredOut.by_kind + combined.filteredOut.by_module,
    );
  });
});

describe("exit codes at the process level", () => {
  test("a repo with no solutions directory and no packs exits 4", async () => {
    const result = await runCli(
      ["find", "x", "--no-sources", "--root", resolve(import.meta.dir, "fixtures/empty-repo")],
      {
        env: { TYPESAFE_API_KEY: "k" },
      },
    );
    expect(result.code).toBe(EXIT.MISSING_CORPUS);
    expect(result.stderr).toContain("missing corpus");
  });

  test("an unexpected failure exits 1 with a hint, and --debug works on every command", async () => {
    const root = tempRepo({ "docs/solutions": "a file where a directory should be\n" });
    const plain = await runCli(["find", "x", "--no-sources", "--root", root], {
      env: { TYPESAFE_API_KEY: "k" },
    });
    expect(plain.code).toBe(EXIT.INTERNAL);
    expect(plain.stderr).toContain("internal error");
    expect(plain.stderr).toContain("--debug");
    const debug = await runCli(["find", "x", "--no-sources", "--root", root, "--debug"], {
      env: { TYPESAFE_API_KEY: "k" },
    });
    expect(debug.code).toBe(EXIT.INTERNAL);
    expect(debug.stderr).toMatch(/\n\s+at /);
    const doctor = await runCli(["doctor", "--debug", "--no-sources", "--root", CORPUS], {
      env: { HOME: EMPTY_HOME },
    });
    expect(doctor.code).toBe(EXIT.OK);
  });

  test("an empty diff on stdin with no other channel is a usage error", async () => {
    const result = await runCli(["find", "--diff", "-", "--no-sources", "--root", CORPUS], {
      env: { TYPESAFE_API_KEY: "k" },
      stdin: "",
    });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("empty");
  });

  test("a work context beyond the request budget is a usage error naming the channel", async () => {
    const lines = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@"];
    for (let i = 0; i < 60; i++) lines.push(`+${"word ".repeat(400)}`);
    const state = await buildWorkState(
      { ...NO_CHANNELS, paths: Array.from({ length: 6000 }, (_, i) => `src/module-${i}/file.ts`) },
      fakeContext(),
    );
    const { assertWorkFits, judgeState } = await import("../src/input/work-state.ts");
    expect(() => assertWorkFits(judgeState(state))).toThrow(/work context is about \d+ tokens/);
  });
});

describe("diff parsing edge cases", () => {
  test("removed lines starting with -- and added lines starting with ++ inside a hunk are content", () => {
    const diff = [
      "diff --git a/q.sql b/q.sql",
      "--- a/q.sql",
      "+++ b/q.sql",
      "@@ -1,2 +1,2 @@",
      "--- old comment",
      "-SELECT 1;",
      "+++ new comment",
      "+SELECT 2;",
    ].join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toEqual(["q.sql"]);
    expect(parsed.removed_lines).toBe(2);
    expect(parsed.added_lines).toBe(2);
    expect(parsed.excerpt).toContain("--- old comment");
  });

  test("a diff touching thousands of files keeps a bounded file list with a count", () => {
    const diff = Array.from(
      { length: 500 },
      (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n+x`,
    ).join("\n");
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.files).toHaveLength(201);
    expect(parsed.files.at(-1)).toBe("[... 300 more files]");
  });
});

describe("symlink boundaries", () => {
  test("a docs/solutions directory that links outside the repository is skipped with a warning", () => {
    const outside = mkdtempSync(join(tmpdir(), "compound-cli-outside-"));
    writeFileSync(join(outside, "private-note.md"), "# Private note\n");
    const root = tempRepo({ "README.md": "x" });
    mkdirSync(join(root, "docs"));
    symlinkSync(outside, join(root, "docs", "solutions"));
    const load = loadLearnings(root, join(root, "docs"));
    expect(load.candidates).toEqual([]);
    expect(load.exists).toBe(false);
    expect(load.warnings[0]).toContain("resolves outside the repository");
  });

  test("a pack candidate whose README links outside the source is skipped", () => {
    const outside = mkdtempSync(join(tmpdir(), "compound-cli-outside-"));
    writeFileSync(join(outside, "secret.md"), RULE("SECRET"));
    const root = tempRepo({
      ".compound-engineering/config.local.yaml": "pack_sources:\n  - source: packs\n",
      "packs/evil/rule.md": RULE("Rule"),
      "packs/fine/README.md": RULE("Fine pack"),
      "packs/fine/rule.md": RULE("Rule"),
    });
    symlinkSync(join(outside, "secret.md"), join(root, "packs/evil/README.md"));
    const load = loadPackCandidates(
      loadCeConfig(root),
      new Set(),
      { HOME: EMPTY_HOME },
      "cached-only",
    );
    expect(load.candidates.map((c) => c.packId)).toEqual(["fine"]);
    expect(load.warnings.join("\n")).toContain("pack `evil` skipped (link(s) outside the source)");
  });
});

describe("packs add hardening", () => {
  test("an inline empty packs value is rewritten into a block list and a comment is kept", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "docs_root: docs\npacks: [] # none yet\n",
    });
    const path = join(root, ".compound-engineering", "config.yaml");
    expect(appendPackEntry(path, renderEntry({ source: "packs", pack: "second-pack" }))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      "docs_root: docs\npacks: # none yet\n  - source: packs\n    pack: second-pack\n",
    );
    expect(loadCeConfig(root).packs).toHaveLength(1);
    expect(loadCeConfig(root).errors).toEqual([]);
  });

  test("values YAML would retype are quoted, and ~/ sources stay plain", () => {
    expect(renderEntry({ source: "~/compound-packs/packs", pack: "1e3" })).toBe(
      '  - source: ~/compound-packs/packs\n    pack: "1e3"',
    );
    expect(renderEntry({ source: "packs", pack: "@scope" })).toBe(
      '  - source: packs\n    pack: "@scope"',
    );
    expect(renderEntry({ source: "packs", pack: "null" })).toBe(
      '  - source: packs\n    pack: "null"',
    );
    expect(
      renderEntry({ source: "https://github.com/o/r.git", ref: "v1", path: "packs", pack: "x" }),
    ).toBe("  - source: https://github.com/o/r.git\n    ref: v1\n    path: packs\n    pack: x");
  });

  test("a write that would leave the config unparsable is rolled back", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml":
        "docs_root: docs\npacks:\n  - source: packs/local-rules\n",
    });
    const path = join(root, ".compound-engineering", "config.yaml");
    const before = readFileSync(path, "utf8");
    expect(() =>
      appendPackEntry(path, "  - source: packs\n    pack: x\n  bad: [unterminated"),
    ).toThrow(/refusing to leave an unparsable config/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a home-source declaration goes to config.local.yaml, not the shared file", async () => {
    const home = mkdtempSync(join(tmpdir(), "compound-cli-home-"));
    cpSync(join(CORPUS, "packs"), join(home, "compound-packs", "packs"), { recursive: true });
    const root = tempRepo({ ".compound-engineering/config.yaml": "docs_root: docs\n" });
    const result = await runCli(["packs", "add", "second-pack", "--yes", "--root", root], {
      env: { HOME: home, CE_PACKS_CACHE_ROOT: seededCacheRoot() },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("config.local.yaml");
    expect(
      readFileSync(join(root, ".compound-engineering", "config.local.yaml"), "utf8"),
    ).toContain("~/compound-packs/packs");
    expect(readFileSync(join(root, ".compound-engineering", "config.yaml"), "utf8")).toBe(
      "docs_root: docs\n",
    );
  });
});

describe("git cache negative cache", () => {
  test("a failed clone is not retried within the cooldown, and refresh clears it", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "compound-cli-cache-"));
    const git = createGitCache({ CE_PACKS_CACHE_ROOT: cacheRoot, CE_PACKS_GIT_TIMEOUT: "5" });
    const url = `file://${mkdtempSync(join(tmpdir(), "compound-cli-notarepo-"))}`;
    const warnings: string[] = [];
    expect(git.clone(url, "main", "test", warnings)).toBeUndefined();
    expect(git.recentlyFailed(url, "main")).toBe(true);
    const root = tempRepo({
      ".compound-engineering/config.local.yaml": `pack_sources:\n  - source: ${url}\n`,
    });
    const load = loadPackCandidates(loadCeConfig(root), new Set(), {
      HOME: EMPTY_HOME,
      CE_PACKS_CACHE_ROOT: cacheRoot,
    });
    expect(load.warnings.join("\n")).toContain("clone failed recently; skipped");
    git.evict(url, "main");
    expect(git.recentlyFailed(url, "main")).toBe(false);
  });

  test("an unwritable CE_PACKS_CACHE_ROOT degrades to no cache instead of crashing", () => {
    const file = join(mkdtempSync(join(tmpdir(), "compound-cli-cache-")), "not-a-dir");
    writeFileSync(file, "x");
    const git = createGitCache({ CE_PACKS_CACHE_ROOT: join(file, "child") });
    expect(git.base).toBeUndefined();
    const warnings: string[] = [];
    expect(git.clone("https://example.invalid/r.git", "main", "test", warnings)).toBeUndefined();
    expect(warnings[0]).toContain("no writable cache root");
  });
});

describe("git-sourced packs end to end", () => {
  let remote: string;
  let work: string;
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "compound-cli-remote-"));
    mkdirSync(join(work, "packs/gitpack"), { recursive: true });
    writeFileSync(join(work, "packs/gitpack/rule.md"), RULE("From git"));
    git(work, "init", "--quiet", "-b", "main");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "init");
    remote = `file://${work}`;
  });

  test("a tree URL clones the base repository at the ref and roots under the path", () => {
    const calls: Array<[string, string]> = [];
    const checkout = mkdtempSync(join(tmpdir(), "compound-cli-checkout-"));
    mkdirSync(join(checkout, "packs/alpha"), { recursive: true });
    writeFileSync(join(checkout, "packs/alpha/one.md"), RULE("One"));
    const fake: GitCache = {
      base: checkout,
      which: () => true,
      recentlyFailed: () => false,
      cachedDir: () => undefined,
      clone: (url, ref) => {
        calls.push([url, ref]);
        return checkout;
      },
      evict: () => {},
      lsRemote: () => undefined,
      headCommit: () => undefined,
    };
    const root = tempRepo({
      ".compound-engineering/config.yaml":
        "packs:\n  - source: https://github.com/o/r/tree/v1/packs\n    pack: alpha\n",
    });
    const resolution = resolvePacks(loadCeConfig(root), fake);
    expect(calls).toEqual([["https://github.com/o/r", "v1"]]);
    expect(resolution.errors).toEqual([]);
    expect(resolution.roots[0]).toMatchObject({
      id: "alpha",
      url: "https://github.com/o/r",
      ref: "v1",
    });
    expect(resolution.roots[0]?.dir).toBe(join(checkout, "packs", "alpha"));
  });

  test("doctor reports drift for a git pack and reachability for a git source", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "compound-cli-cache-"));
    const root = tempRepo({
      ".compound-engineering/config.yaml": `packs:\n  - source: ${remote}\n    ref: main\n    path: packs\npack_sources:\n  - source: ${remote}\n    ref: main\n    path: packs\n`,
    });
    const env = { HOME: EMPTY_HOME, CE_PACKS_CACHE_ROOT: cacheRoot, CE_PACKS_GIT_TIMEOUT: "20" };
    const current = await runCli(["doctor", "--json", "--root", root], { env });
    expect(current.code).toBe(0);
    const before = JSON.parse(current.stdout);
    expect(before.packs.roots[0]).toMatchObject({ id: "gitpack", drift: "current" });
    expect(before.packs.roots[0].cached_commit).toBe(before.packs.roots[0].remote_commit);
    expect(
      before.known_sources.find((s: { source: string }) => s.source === `${remote}@main`).status,
    ).toBe("reachable, cached");

    writeFileSync(join(work, "packs/gitpack/another.md"), RULE("Another"));
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "more");
    const stale = await runCli(["doctor", "--json", "--root", root], { env });
    const after = JSON.parse(stale.stdout);
    expect(after.packs.roots[0].drift).toBe("stale");
    expect(after.packs.roots[0].cached_commit).not.toBe(after.packs.roots[0].remote_commit);
  }, 60_000);
});

describe("bench gate fidelity", () => {
  const CASES_DIR = mkdtempSync(join(tmpdir(), "compound-cli-bench-"));
  const query =
    "Give the CLI a distinct exit code when a lookup finds nothing, so callers can tell it from a crash";
  const negative = "Rotate the TLS certificate on the load balancer before it expires";
  const env = {
    COMPOUND_CASSETTE_MODE: "replay",
    COMPOUND_CASSETTE_DIR: join(CASSETTES, "bench-fixture"),
  };

  function casesFile(
    name: string,
    expected: string[],
    floor: Record<string, number>,
    corpus: unknown = null,
  ): string {
    const path = join(CASES_DIR, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        name,
        corpus,
        floor,
        cases: [
          { id: "exit-codes", query: { activity: query }, expected },
          { id: "tls", query: { activity: negative }, expected: [], negative: true },
        ],
      }),
    );
    return path;
  }

  test("a recall regression fails the floor with exit 1 and the report still prints", async () => {
    const cases = casesFile("miss", ["docs/solutions/email/gmail-sync-null-bytes.md"], {
      macro_recall: 0.99,
    });
    const result = await runCli(
      ["bench", "--cases", cases, "--root", CORPUS, "--json", "--enforce-floor"],
      { env },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("macro recall 0 is below the floor 0.99");
    expect(JSON.parse(result.stdout).aggregate.macro_recall).toBe(0);
  });

  test("an expected path that is not in the corpus is a labeling error and fails the gate", async () => {
    const cases = casesFile("label", ["docs/solutions/nope.md"], { macro_recall: 0 });
    const result = await runCli(
      ["bench", "--cases", cases, "--root", CORPUS, "--json", "--enforce-floor"],
      { env },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("labeling errors fail the gate");
    expect(JSON.parse(result.stdout).aggregate.labeling_errors).toBe(1);
  });

  test("a threshold change against recorded cassettes is caught by the manifest", async () => {
    const cases = casesFile(
      "thresh",
      ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
      { macro_recall: 0.5 },
    );
    const result = await runCli(
      [
        "bench",
        "--cases",
        cases,
        "--root",
        CORPUS,
        "--json",
        "--enforce-floor",
        "--threshold",
        "0.01",
      ],
      { env },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `threshold 0.01 differs from the recorded ${DEFAULTS.threshold}`,
    );
  });

  test("a replay with no manifest fails the gate: nothing pins the recorded threshold", async () => {
    const unpinned = mkdtempSync(join(tmpdir(), "compound-cli-unpinned-"));
    cpSync(join(CASSETTES, "bench-fixture"), unpinned, {
      recursive: true,
      filter: (src) => !src.endsWith("manifest.json"),
    });
    const cases = casesFile(
      "unpinned",
      ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
      { macro_recall: 0.5 },
    );
    const result = await runCli(
      ["bench", "--cases", cases, "--root", CORPUS, "--json", "--enforce-floor"],
      { env: { ...env, COMPOUND_CASSETTE_DIR: unpinned } },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no readable manifest.json");
  });

  test("auto mode writes the pin for a fresh recording and keeps an existing one", async () => {
    const unpinned = mkdtempSync(join(tmpdir(), "compound-cli-autopin-"));
    cpSync(join(CASSETTES, "bench-fixture"), unpinned, {
      recursive: true,
      filter: (src) => !src.endsWith("manifest.json"),
    });
    const cases = casesFile(
      "autopin",
      ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
      { macro_recall: 0.5 },
    );
    const autoEnv = {
      ...env,
      COMPOUND_CASSETTE_MODE: "auto",
      COMPOUND_CASSETTE_DIR: unpinned,
      TYPESAFE_API_KEY: "never-used-every-request-replays",
    };
    const first = await runCli(
      ["bench", "--cases", cases, "--root", CORPUS, "--json", "--enforce-floor"],
      { env: autoEnv },
    );
    expect(first.code).toBe(0);
    const pinned = JSON.parse(readFileSync(join(unpinned, "manifest.json"), "utf8"));
    expect(pinned.threshold).toBe(DEFAULTS.threshold);

    const drifted = await runCli(
      [
        "bench",
        "--cases",
        cases,
        "--root",
        CORPUS,
        "--json",
        "--enforce-floor",
        "--threshold",
        "0.01",
      ],
      { env: autoEnv },
    );
    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toContain(
      `threshold 0.01 differs from the recorded ${DEFAULTS.threshold}`,
    );
    expect(JSON.parse(readFileSync(join(unpinned, "manifest.json"), "utf8")).threshold).toBe(
      DEFAULTS.threshold,
    );
  });

  test("the corpus block clones through the git cache; an unreachable ref exits 4", async () => {
    const work = mkdtempSync(join(tmpdir(), "compound-cli-corpus-"));
    cpSync(join(CORPUS, "docs"), join(work, "docs"), { recursive: true });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: work,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    git("init", "--quiet", "-b", "main");
    git("add", ".");
    git("commit", "--quiet", "-m", "corpus");
    const remote = `file://${work}`;
    const cacheEnv = {
      ...env,
      CE_PACKS_CACHE_ROOT: mkdtempSync(join(tmpdir(), "compound-cli-cache-")),
      CE_PACKS_GIT_TIMEOUT: "20",
    };
    const ok = await runCli(
      [
        "bench",
        "--cases",
        casesFile(
          "clone",
          ["docs/solutions/cli/exit-codes-for-expected-empty-results.md"],
          { macro_recall: 0.99 },
          { git: remote, ref: "main", docs_root: "docs" },
        ),
        "--json",
        "--enforce-floor",
      ],
      { env: cacheEnv },
    );
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).corpus.root).toContain(cacheEnv.CE_PACKS_CACHE_ROOT);
    const missing = await runCli(
      [
        "bench",
        "--cases",
        casesFile("noref", ["x"], {}, { git: remote, ref: "does-not-exist" }),
        "--json",
      ],
      { env: cacheEnv },
    );
    expect(missing.code).toBe(EXIT.MISSING_CORPUS);
    expect(missing.stderr).toContain("does-not-exist");
  }, 60_000);
});
