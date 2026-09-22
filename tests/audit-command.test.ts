import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "../src/exit-codes.ts";
import { startFakeTypeSafe } from "./helpers/fake-typesafe.ts";
import { cassetteEnv, tempDir, tempRepo } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

const FIXTURE_CORPUS = resolve(import.meta.dir, "fixtures/audit");
const judge = startFakeTypeSafe({ noul: 0.9, scoreLevel: 3 });
const HOME = tempDir("compound-cli-home-");
const withJudge = {
  HOME,
  TYPESAFE_API_KEY: "fake-key-for-the-fake-server",
  TYPESAFE_BASE_URL: judge.url,
};
const noKey = { HOME };

afterAll(() => judge.stop());

/** A writable copy of the fixture corpus, so --fix can write. */
function corpusCopy(): string {
  const dir = tempDir("compound-cli-audit-corpus-");
  cpSync(FIXTURE_CORPUS, dir, { recursive: true });
  return dir;
}

function bodyOf(text: string): string {
  const parts = text.split(/^---$/m);
  return parts.slice(2).join("---");
}

describe("compound audit: report only", () => {
  test("the fixture corpus exits 6 with one finding per failure class and a summary", async () => {
    const result = await runCli(["audit", "--root", FIXTURE_CORPUS, "--json"], { env: noKey });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    expect(report.schema_version).toBe(1);
    expect(report.fix).toBe("off");
    expect(report.summary.files).toBe(19);
    expect(report.summary.files_failing).toBe(12);
    expect(report.summary.errors).toBeGreaterThan(10);
    expect(report.summary.fixes_applied).toBe(0);
    const byPath = Object.fromEntries(
      report.files.map((f: { path: string; findings: Array<{ rule: string }> }) => [
        f.path.split("/").pop(),
        f.findings.map((x) => x.rule),
      ]),
    );
    expect(byPath["clean.md"]).toEqual([]);
    expect(byPath["missing-frontmatter.md"]).toEqual(["frontmatter.missing"]);
    expect(byPath["bug-track-missing.md"]).toEqual([
      "symptoms.missing",
      "root_cause.missing",
      "resolution_type.missing",
    ]);
    expect(byPath["applies-when-generic.md"]).toEqual(["applies_when.generic"]);

    const text = await runCli(["audit", "--root", FIXTURE_CORPUS], { env: noKey });
    expect(text.code).toBe(EXIT.FINDINGS);
    expect(text.stdout).toContain("compound audit: 19 files, 7 passing");
    expect(text.stdout).toMatch(
      /error {3}problem_type\.invalid {7,}problem_type "Best Practice" is not a schema value/,
    );
  });

  test("a clean corpus exits 0, --strict turns warnings into a failure, --report writes the JSON", async () => {
    const root = tempRepo({
      "docs/solutions/clean.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/clean.md"),
        "utf8",
      ),
      "docs/solutions/weak.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/title-weak.md"),
        "utf8",
      ),
    });
    const lenient = await runCli(["audit", "--root", root], { env: noKey });
    expect(lenient.code).toBe(EXIT.OK);
    expect(lenient.stdout).toContain("2 files, 2 passing, 0 errors, 1 warning");
    const report = join(root, "out", "audit.json");
    const strict = await runCli(["audit", "--root", root, "--strict", "--report", report], {
      env: noKey,
    });
    expect(strict.code).toBe(EXIT.FINDINGS);
    expect(strict.stdout).toContain("strict");
    const written = JSON.parse(readFileSync(report, "utf8"));
    expect(written.strict).toBe(true);
    expect(written.summary.files_failing).toBe(1);
  });

  test("no docs/solutions is a missing corpus; an empty one passes", async () => {
    const none = tempRepo({ "README.md": "x\n" });
    const missing = await runCli(["audit", "--root", none], { env: noKey });
    expect(missing.code).toBe(EXIT.MISSING_CORPUS);
    const empty = tempRepo({ "docs/solutions/.keep": "" });
    const ok = await runCli(["audit", "--root", empty], { env: noKey });
    expect(ok.code).toBe(EXIT.OK);
    expect(ok.stdout).toContain("0 files");
  });

  test("--packs audits declared pack rules with the packs rule set and never fixes them", async () => {
    const pack = tempDir("compound-cli-pack-");
    writeFileSync(
      join(pack, "README.md"),
      "---\ntitle: A pack\napplies_when:\n  - a\n  - b\n  - c\ntags: [local-pack]\n---\n# Pack\n",
    );
    writeFileSync(
      join(pack, "rule.md"),
      '---\ntitle: A rule missing its record type\napplies_when:\n  - "Deciding how to gate a feature behind a flag"\ntags: [flipper]\nmodule: flags\nproblem_type: convention\n---\n# Rule\n',
    );
    const root = tempRepo({
      "docs/solutions/clean.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/clean.md"),
        "utf8",
      ),
      ".compound-engineering/config.yaml": `packs:\n  - source: ${pack}\n`,
    });
    const result = await runCli(["audit", "--root", root, "--packs", "--json"], { env: noKey });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    const rule = report.files.find((f: { kind: string }) => f.kind === "pack_rule");
    expect(rule.findings.map((f: { rule: string }) => f.rule)).toEqual(["record_type.invalid"]);
    expect(report.files.some((f: { path: string }) => f.path.endsWith("README.md"))).toBe(false);

    const fix = await runCli(["audit", "--root", root, "--packs", "--fix", "--dry-run", "--json"], {
      env: withJudge,
    });
    const fixed = JSON.parse(fix.stdout).files.find(
      (f: { kind: string }) => f.kind === "pack_rule",
    );
    // Pack rule findings carry no fixer, so --fix proposes nothing and the cache is never written.
    expect(fixed.fix).toBeUndefined();
    expect(readFileSync(join(pack, "rule.md"), "utf8")).not.toContain("record_type");
  });

  test("doctor carries the audit counts", async () => {
    const result = await runCli(["doctor", "--json", "--no-sources", "--root", FIXTURE_CORPUS], {
      env: noKey,
    });
    expect(result.code).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout);
    expect(report.audit.files).toBe(19);
    expect(report.audit.files_failing).toBe(12);
    const text = await runCli(["doctor", "--no-sources", "--root", FIXTURE_CORPUS], { env: noKey });
    expect(text.stdout).toContain("audit: 19 files, 12 failing");
    expect(text.stdout).toContain("compound audit --fix");
  });
});

describe("compound audit --fix", () => {
  test("without a key --fix exits 3 before reading any file; --dry-run and --yes need --fix; off a TTY --fix needs --yes or --dry-run", async () => {
    const root = tempRepo({ "docs/solutions/x.md": "not even frontmatter\n" });
    const noFix = await runCli(["audit", "--root", root, "--fix"], { env: noKey });
    expect(noFix.code).toBe(EXIT.NOT_CONFIGURED);
    expect(noFix.stderr).toContain("TYPESAFE_API_KEY");
    const stray = await runCli(["audit", "--root", root, "--yes"], { env: noKey });
    expect(stray.code).toBe(EXIT.USAGE);
    const positional = await runCli(["audit", "--root", root, "docs/solutions/x.md"], {
      env: noKey,
    });
    expect(positional.code).toBe(EXIT.USAGE);
    expect(positional.stderr).toContain("takes no file arguments");
    const noTty = await runCli(["audit", "--root", root, "--fix"], { env: withJudge });
    expect(noTty.code).toBe(EXIT.USAGE);
    expect(noTty.stderr).toContain("--yes");
    expect(noTty.stderr).toContain("--dry-run");
  });

  test("--dry-run shows every diff, writes nothing, and reports what would change and what needs an author", async () => {
    const root = corpusCopy();
    const before = Object.fromEntries(
      ["enum-casing.md", "bug-track-missing.md", "clean.md"].map((f) => [
        f,
        statSync(join(root, "docs/solutions", f)).mtimeMs,
      ]),
    );
    const result = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
      env: withJudge,
    });
    const report = JSON.parse(result.stdout);
    expect(report.fix).toBe("dry-run");
    expect(result.code).toBe(EXIT.FINDINGS);
    expect(report.summary.fixes_proposed).toBeGreaterThan(10);
    expect(report.summary.fixes_applied).toBe(0);
    // The summary describes the disk; the projection says what a --yes run would leave.
    expect(report.summary.files_failing).toBe(12);
    expect(report.summary.after_fix.files_failing).toBeLessThan(12);
    expect(report.thresholds).toEqual({ choice: 0.4, tag: 0.6, situation: 0.7, symptom: 0.7 });
    expect(
      report.files.every((f: { findings: Array<{ fixer: unknown }> }) =>
        f.findings.every((x) => "fixer" in x),
      ),
    ).toBe(true);
    const enums = report.files.find((f: { path: string }) => f.path.endsWith("enum-casing.md"));
    expect(enums.fix.diff).toContain("-problem_type: Best Practice");
    expect(enums.fix.diff).toContain("+problem_type: best_practice");
    expect(enums.fix.remaining).toEqual([]);
    const tables = report.files.find((f: { path: string }) =>
      f.path.endsWith("applies-when-missing-no-prose.md"),
    );
    expect(tables.fix.needs_author).toEqual([
      { field: "applies_when", reason: "the body yields no situation sentence to judge" },
    ]);
    const bare = report.files.find((f: { path: string }) =>
      f.path.endsWith("missing-frontmatter.md"),
    );
    expect(bare.fix).toBeUndefined();
    for (const [f, mtime] of Object.entries(before)) {
      expect(statSync(join(root, "docs/solutions", f)).mtimeMs, f).toBe(mtime);
    }
    expect(readFileSync(join(root, "docs/solutions/enum-casing.md"), "utf8")).toContain(
      "problem_type: Best Practice",
    );
  });

  test("--yes writes, bodies stay byte-identical, the exit code reflects what remains, and a second run changes nothing", async () => {
    const root = corpusCopy();
    const files = [
      "enum-casing.md",
      "bug-track-missing.md",
      "tags-scalar.md",
      "unsafe-scalar.md",
      "applies-when-generic.md",
    ];
    const bodies = Object.fromEntries(
      files.map((f) => [f, bodyOf(readFileSync(join(root, "docs/solutions", f), "utf8"))]),
    );

    const first = await runCli(["audit", "--root", root, "--fix", "--yes", "--json"], {
      env: withJudge,
    });
    const report = JSON.parse(first.stdout);
    expect(report.fix).toBe("applied");
    expect(report.summary.fixes_applied).toBeGreaterThan(10);
    // missing-frontmatter, unterminated, and invalid-yaml cannot be fixed, so findings remain.
    expect(first.code).toBe(EXIT.FINDINGS);
    for (const f of files) {
      expect(bodyOf(readFileSync(join(root, "docs/solutions", f), "utf8")), f).toBe(
        bodies[f] as string,
      );
    }
    const enums = readFileSync(join(root, "docs/solutions/enum-casing.md"), "utf8");
    expect(enums).toContain("problem_type: best_practice");
    expect(enums).toContain("severity: high");
    const bug = readFileSync(join(root, "docs/solutions/bug-track-missing.md"), "utf8");
    expect(bug).toMatch(/symptoms:\n {2}- When the sync job runs twice/);
    expect(bug).toContain("resolution_type: code_fix");
    const unsafe = readFileSync(join(root, "docs/solutions/unsafe-scalar.md"), "utf8");
    expect(unsafe).toContain('title: "Retry budget #2 for the HTTP client"');

    const second = await runCli(["audit", "--root", root, "--fix", "--yes", "--json"], {
      env: withJudge,
    });
    const again = JSON.parse(second.stdout);
    expect(again.summary.fixes_applied).toBe(0);
    expect(
      again.files.every(
        (f: { fix?: { changes: unknown[] } }) => !f.fix || f.fix.changes.length === 0,
      ),
    ).toBe(true);
    for (const f of files) {
      expect(bodyOf(readFileSync(join(root, "docs/solutions", f), "utf8")), f).toBe(
        bodies[f] as string,
      );
    }
  });

  test("an applied run reports no projection, even when a file was needs_author-only or a pack rule", async () => {
    const pack = tempDir("compound-cli-pack-");
    writeFileSync(
      join(pack, "README.md"),
      "---\ntitle: A pack\napplies_when:\n  - a\n  - b\n  - c\ntags: [local-pack]\n---\n# Pack\n",
    );
    writeFileSync(
      join(pack, "rule.md"),
      '---\ntitle: A rule missing its record type\napplies_when:\n  - "Deciding how to gate a feature behind a flag"\ntags: [flipper]\nmodule: flags\nproblem_type: convention\n---\n# Rule\n',
    );
    const root = tempRepo({
      "docs/solutions/tables.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/applies-when-missing-no-prose.md"),
        "utf8",
      ),
      "docs/solutions/enums.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/enum-casing.md"),
        "utf8",
      ),
      ".compound-engineering/config.yaml": `packs:\n  - source: ${pack}\n`,
    });
    const applied = await runCli(["audit", "--root", root, "--packs", "--fix", "--yes", "--json"], {
      env: withJudge,
    });
    const report = JSON.parse(applied.stdout);
    expect(report.fix).toBe("applied");
    expect(report.summary.fixes_applied).toBeGreaterThan(0);
    expect(report.summary.needs_author).toBe(1);
    expect(report.summary.after_fix).toBeNull();
    // The same corpus as a dry run does carry the projection.
    const dry = await runCli(
      [
        "audit",
        "--root",
        tempRepo({
          "docs/solutions/enums.md": readFileSync(
            join(FIXTURE_CORPUS, "docs/solutions/enum-casing.md"),
            "utf8",
          ),
        }),
        "--fix",
        "--dry-run",
        "--json",
      ],
      { env: withJudge },
    );
    expect(JSON.parse(dry.stdout).summary.after_fix).toEqual({
      errors: 0,
      warnings: 0,
      files_failing: 0,
    });
  });

  test("a judge that rejects everything leaves the file to its author and invents nothing", async () => {
    const rejecting = startFakeTypeSafe({ noul: 0.1, scoreLevel: 0 });
    try {
      const root = corpusCopy();
      const result = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
        env: { ...withJudge, TYPESAFE_BASE_URL: rejecting.url },
      });
      const report = JSON.parse(result.stdout);
      const generic = report.files.find((f: { path: string }) =>
        f.path.endsWith("applies-when-generic.md"),
      );
      expect(generic.fix.changes).toEqual([]);
      expect(generic.fix.needs_author[0].field).toBe("applies_when");
      const bug = report.files.find((f: { path: string }) =>
        f.path.endsWith("bug-track-missing.md"),
      );
      // The fake judge answers every Choice with probability 1, so only the Noul-judged field goes to the author.
      expect(bug.fix.needs_author.map((n: { field: string }) => n.field)).toEqual(["symptoms"]);
      expect(
        bug.fix.changes.find((c: { field: string }) => c.field === "symptoms"),
      ).toBeUndefined();
    } finally {
      rejecting.stop();
    }
  });

  test("one real file end to end against recorded answers", async () => {
    const root = corpusCopy();
    const env = { HOME, ...cassetteEnv(resolve(import.meta.dir, "fixtures/cassettes/audit")) };
    const result = await runCli(["audit", "--root", root, "--fix", "--yes", "--json"], { env });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    const bug = report.files.find((f: { path: string }) => f.path.endsWith("bug-track-missing.md"));
    expect(bug.fix.changes.map((c: { field: string }) => c.field).sort()).toEqual([
      "resolution_type",
      "root_cause",
      "symptoms",
    ]);
    expect(
      bug.fix.changes.find((c: { field: string }) => c.field === "symptoms").value[0],
    ).toContain("unique index error");
    expect(bug.fix.remaining).toEqual([]);
    expect(report.usage.requests).toBeGreaterThan(0);
  });
});

describe("robustness", () => {
  test("malformed YAML, binary bytes, and a directory named .md are reported, not fatal", async () => {
    const root = tempRepo({
      "docs/solutions/bad.md": "---\ntitle: [\n---\nbody\n",
      "docs/solutions/dir.md/.keep": "",
      "docs/solutions/good.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/clean.md"),
        "utf8",
      ),
    });
    writeFileSync(
      join(root, "docs/solutions/bin.md"),
      Buffer.concat([
        Buffer.from("---\ntitle: bin\n---\n"),
        Buffer.from([0, 255, 254]),
        Buffer.alloc(512, 0x9f),
      ]),
    );
    const result = await runCli(["audit", "--root", root, "--json"], { env: noKey });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    expect(report.summary.files).toBe(3);
    expect(
      report.files.find((f: { path: string }) => f.path.endsWith("bad.md")).findings[0].rule,
    ).toBe("frontmatter.invalid_yaml");
  });

  test("1,001 files audit in well under ten seconds without a key, and --fix --dry-run batches its questions", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) {
      files[`docs/solutions/area${i % 10}/learning-${i}.md`] =
        `---\ntitle: Filler learning ${i} about queue workers\ndate: 2026-01-01\nmodule: queue\ncomponent: background_job\nproblem_type: best_practice\nseverity: low\napplies_when:\n  - "Working on queue worker ${i} when it stalls"\ntags: [queue, worker]\n---\n# Filler ${i}\n\nWhen worker ${i} stalls the queue backs up.\n`;
    }
    files["docs/solutions/broken.md"] =
      "---\ntitle: Broken enum learning about queues\ndate: 2026-01-01\nmodule: queue\ncomponent: background_job\nproblem_type: Best Practice\nseverity: low\ntags: [queue]\n---\n# Broken\n\nWhen the queue stalls, workers back up.\n";
    const root = tempRepo(files);
    const started = performance.now();
    const result = await runCli(["audit", "--root", root, "--json"], { env: noKey });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    expect(report.summary.files).toBe(1001);
    expect(report.summary.files_failing).toBe(1);

    const before = judge.requests();
    const fix = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
      env: withJudge,
    });
    // A dry run writes nothing, so the exit code still describes the corpus on disk.
    expect(fix.code).toBe(EXIT.FINDINGS);
    const projected = JSON.parse(fix.stdout).summary;
    expect(projected.files_failing).toBe(1);
    expect(projected.after_fix.files_failing).toBe(0);
    // One file needs Jev (applies_when), one Noul batch: far under one request per file.
    expect(judge.requests() - before).toBeLessThanOrEqual(2);
  });
});
