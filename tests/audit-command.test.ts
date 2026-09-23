import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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

/** A pack README that passes: three real situations and the pack id among the tags. */
function packReadme(packId: string): string {
  return `---\ntitle: Feature flag conventions for the team\napplies_when:\n  - "Deciding how to gate a feature behind a flag"\n  - "Removing a flag after its rollout finished"\n  - "Naming a new flag for an experiment"\ntags: [flipper, ${packId}]\n---\n# Pack\n`;
}

const PACK_RULE =
  '---\ntitle: Prefer plain flipper checks over wrappers\napplies_when:\n  - "Deciding how to gate a feature behind a flag"\ntags: [flipper]\nmodule: flags\nproblem_type: convention\nrecord_type: rule\n---\n# Rule\n';

/** compound-packs' `record_type`, declared the way its config does. */
const RECORD_TYPE_CONFIG =
  "compound:\n  schema:\n    fields:\n      record_type:\n        type: enum\n        values: [decision, rule, observation]\n        required: true\n        kinds: [pack_rule]\n";

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

  test("--packs audits declared pack rules and READMEs with the packs rule set and never fixes them", async () => {
    const pack = tempDir("compound-cli-pack-");
    writeFileSync(join(pack, "README.md"), packReadme("not-the-pack-id"));
    writeFileSync(join(pack, "rule.md"), PACK_RULE.replace("record_type: rule\n", ""));
    const root = tempRepo({
      "docs/solutions/clean.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/clean.md"),
        "utf8",
      ),
      ".compound-engineering/config.yaml": `packs:\n  - source: ${pack}\n${RECORD_TYPE_CONFIG}`,
    });
    const result = await runCli(["audit", "--root", root, "--packs", "--json"], { env: noKey });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    const rule = report.files.find((f: { kind: string }) => f.kind === "pack_rule");
    expect(rule.findings.map((f: { rule: string; source: string }) => [f.rule, f.source])).toEqual([
      ["record_type.missing", "config.yaml"],
    ]);
    const readme = report.files.find((f: { kind: string }) => f.kind === "pack_readme");
    expect(readme.path).toBe(`${basename(pack)}/README.md`);
    expect(readme.findings.map((f: { rule: string }) => f.rule)).toEqual([
      "pack.readme_tag_missing",
    ]);

    const fix = await runCli(
      ["audit", "--root", root, "--packs", "--fix", "--jev", "--dry-run", "--json"],
      { env: withJudge },
    );
    const fixed = JSON.parse(fix.stdout).files.find(
      (f: { kind: string }) => f.kind === "pack_rule",
    );
    // Declared pack files live in the cache: --fix names the pack's repository and writes nothing.
    expect(fixed.fix.changes).toEqual([]);
    expect(fixed.fix.needs_author[0].reason).toContain("pack's own repository");
    expect(readFileSync(join(pack, "rule.md"), "utf8")).not.toContain("record_type");
  });

  test("--pack-dir audits a repository of packs: README bounds, the pack id tag, a missing README, a pack without rules", async () => {
    const root = tempRepo({
      "packs/flags/README.md": packReadme("flags"),
      "packs/flags/plain-checks.md": PACK_RULE,
      "packs/flags/notes/nested.md": PACK_RULE,
      "packs/thin/README.md": packReadme("thin").replace(
        '  - "Naming a new flag for an experiment"\n',
        "",
      ),
      "packs/thin/rule.md": PACK_RULE.replace("record_type: rule", "record_type: memo"),
      "packs/readme-only/README.md": packReadme("readme-only"),
      "packs/no-readme/rule.md": PACK_RULE,
      ".compound-engineering/config.yaml": RECORD_TYPE_CONFIG,
    });
    const result = await runCli(["audit", "--root", root, "--pack-dir", "packs", "--json"], {
      env: noKey,
    });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    const byPath = Object.fromEntries(
      report.files.map((f: { path: string; findings: Array<{ rule: string }> }) => [
        f.path,
        f.findings.map((x) => x.rule),
      ]),
    );
    expect(byPath).toEqual({
      "packs/flags/README.md": [],
      "packs/flags/plain-checks.md": [],
      "packs/thin/README.md": ["applies_when.too_few"],
      "packs/thin/rule.md": ["record_type.invalid"],
      "packs/readme-only/README.md": ["pack.no_rules"],
      "packs/no-readme/rule.md": [],
      "packs/no-readme/README.md": ["pack.readme_missing"],
    });
    expect(report.summary.files).toBe(7);
    const text = await runCli(["audit", "--root", root, "--pack-dir", "packs"], { env: noKey });
    expect(text.stdout).toContain(
      'record_type "memo" is not in this repository\'s list (decision, rule, observation)  [rule from config.yaml]',
    );
    expect(text.stdout).toContain("applies_when has 2 items; at least 3 are needed  [no fixer]");
    expect(text.stdout).toContain("pack.no_rules");
    // The config can name the directories, so CI runs plain `audit`.
    const configured = await runCli(["audit", "--root", root, "--json"], { env: noKey });
    expect(configured.code).toBe(EXIT.MISSING_CORPUS);
    writeFileSync(
      join(root, ".compound-engineering/config.yaml"),
      `${RECORD_TYPE_CONFIG}  audit:\n    pack_dirs: [packs]\n`,
    );
    const fromConfig = await runCli(["audit", "--root", root, "--json"], { env: noKey });
    expect(JSON.parse(fromConfig.stdout).summary.files).toBe(7);
    const missing = await runCli(["audit", "--root", root, "--pack-dir", "nowhere"], {
      env: noKey,
    });
    expect(missing.code).toBe(EXIT.USAGE);
    expect(missing.stderr).toContain("--pack-dir nowhere");
  });

  test("--stats reports field coverage and pack README coverage without changing the exit code", async () => {
    const root = tempRepo({
      "docs/solutions/clean.md": readFileSync(
        join(FIXTURE_CORPUS, "docs/solutions/clean.md"),
        "utf8",
      ),
      "docs/solutions/broken.md": "---\ntitle: [\n---\nbody\n",
      "docs/solutions/thin.md":
        "---\ntitle: A learning with only a title and a date\ndate: 2026-01-01\n---\nbody\n",
      "packs/flags/README.md": packReadme("flags"),
      "packs/flags/plain-checks.md": PACK_RULE,
      "packs/flags/far.md": PACK_RULE.replace(
        '  - "Deciding how to gate a feature behind a flag"',
        '  - "Choosing a database index for a slow report query"',
      ),
      ".compound-engineering/config.yaml": RECORD_TYPE_CONFIG,
    });
    const result = await runCli(
      ["audit", "--root", root, "--pack-dir", "packs", "--stats", "--json"],
      { env: noKey },
    );
    const report = JSON.parse(result.stdout);
    expect(report.stats.learnings).toEqual({
      total: 3,
      unparsable: 1,
      with: { title: 2, applies_when: 1, symptoms: 0, tags: 1 },
    });
    expect(report.stats.readme_coverage).toHaveLength(1);
    expect(report.stats.readme_coverage[0].path).toBe("packs/flags/far.md");
    expect(report.stats.readme_coverage[0].lacking).toContain("database");
    const text = await runCli(["audit", "--root", root, "--pack-dir", "packs", "--stats"], {
      env: noKey,
    });
    expect(text.stdout).toContain("learnings: 3 (1 with unparsable frontmatter)");
    expect(text.stdout).toContain("  with applies_when: 1 (33%)");
    expect(text.stdout).toContain("readme coverage: 1 rule shares under 25%");
    expect(text.stdout).toContain(
      "packs/flags/far.md: 0% of its situation words appear in the README",
    );
  });

  test("the config's audit section: exclude leaves indexes out, ignore drops rules, strict is the default, and errors stop the run", async () => {
    const clean = readFileSync(join(FIXTURE_CORPUS, "docs/solutions/clean.md"), "utf8");
    const weak = readFileSync(join(FIXTURE_CORPUS, "docs/solutions/title-weak.md"), "utf8");
    const files = {
      "docs/solutions/clean.md": clean,
      "docs/solutions/weak.md": weak,
      "docs/solutions/patterns/index.md": "# Not a learning\n",
    };
    const bare = await runCli(["audit", "--root", tempRepo(files), "--json"], { env: noKey });
    expect(bare.code).toBe(EXIT.FINDINGS);
    expect(JSON.parse(bare.stdout).summary).toMatchObject({ files: 3, errors: 1, warnings: 1 });

    const policy = tempRepo({
      ...files,
      ".compound-engineering/config.yaml":
        "compound:\n  audit:\n    exclude: [docs/solutions/patterns/]\n    ignore: [title.weak]\n",
    });
    const shaped = await runCli(["audit", "--root", policy, "--json"], { env: noKey });
    expect(shaped.code).toBe(EXIT.OK);
    const report = JSON.parse(shaped.stdout);
    expect(report.summary).toMatchObject({ files: 2, errors: 0, warnings: 0 });
    expect(report.excluded).toEqual(["docs/solutions/patterns/index.md"]);
    expect((await runCli(["audit", "--root", policy], { env: noKey })).stdout).toContain(
      "1 excluded by config",
    );

    const strict = tempRepo({
      ...files,
      ".compound-engineering/config.yaml":
        "compound:\n  audit:\n    exclude: [docs/solutions/patterns/index.md]\n    strict: true\n",
    });
    const asConfigured = await runCli(["audit", "--root", strict, "--json"], { env: noKey });
    expect(asConfigured.code).toBe(EXIT.FINDINGS);
    expect(JSON.parse(asConfigured.stdout).strict).toBe(true);

    const broken = tempRepo({
      ...files,
      ".compound-engineering/config.yaml":
        "compound:\n  schema:\n    fields:\n      component:\n        closed: yes\n        values: []\n",
    });
    const refused = await runCli(["audit", "--root", broken], { env: noKey });
    expect(refused.code).toBe(EXIT.USAGE);
    expect(refused.stderr).toContain("compound: block of the config has problems");
    expect(refused.stderr).toContain(
      "`compound.schema.fields.component.values` must be a non-empty list",
    );
  });

  test("a well-formed declaration that cannot mean anything is refused too, never run against a half-applied schema", async () => {
    const clean = readFileSync(join(FIXTURE_CORPUS, "docs/solutions/clean.md"), "utf8");
    const meaningless = tempRepo({
      "docs/solutions/clean.md": clean,
      ".compound-engineering/config.yaml":
        "compound:\n  schema:\n    fields:\n      module:\n        closed: true\n      applies_when:\n        min_items: 6\n        max_items: 2\n",
    });
    const refused = await runCli(["audit", "--root", meaningless, "--json"], { env: noKey });
    expect(refused.code).toBe(EXIT.USAGE);
    expect(refused.stderr).toContain("`module` is closed but has no values");
    expect(refused.stderr).toContain("`applies_when` has min_items above max_items");
    expect(refused.stdout).toBe("");
    const doctor = await runCli(["doctor", "--json", "--no-sources", "--root", meaningless], {
      env: noKey,
    });
    expect(JSON.parse(doctor.stdout).audit.config_errors).toHaveLength(2);
    expect(
      (await runCli(["doctor", "--no-sources", "--root", meaningless], { env: noKey })).stdout,
    ).toContain("config error:");
  });

  test("plain --fix names the judge for a closed enum spelling could not map, schema or custom", async () => {
    const root = tempRepo({
      "docs/solutions/odd.md": readFileSync(join(FIXTURE_CORPUS, "docs/solutions/clean.md"), "utf8")
        .replace("problem_type: best_practice", "problem_type: bogus")
        .replace("severity: medium", "severity: medium\nrecord_type: memo"),
      ".compound-engineering/config.yaml":
        "compound:\n  schema:\n    fields:\n      record_type:\n        type: enum\n        values: [decision, rule, observation]\n",
    });
    const result = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
      env: noKey,
    });
    const file = JSON.parse(result.stdout).files[0];
    expect(file.findings.map((f: { rule: string; fixer: string }) => [f.rule, f.fixer])).toEqual([
      ["problem_type.invalid", "deterministic"],
      ["record_type.invalid", "deterministic"],
    ]);
    expect(file.fix.changes).toEqual([]);
    expect(file.fix.needs_author).toEqual([
      { field: "problem_type", reason: "needs the judge: run --fix --jev (problem_type.invalid)" },
      { field: "record_type", reason: "needs the judge: run --fix --jev (record_type.invalid)" },
    ]);
    // With the judge, the same file is settled from the values in effect.
    const jev = await runCli(["audit", "--root", root, "--fix", "--jev", "--dry-run", "--json"], {
      env: withJudge,
    });
    const fixed = JSON.parse(jev.stdout).files[0];
    const picked = fixed.fix.changes.map((c: { field: string; value: string }) => [
      c.field,
      c.value,
    ]);
    // The fake judge takes the first option, which moves the file onto the bug track; the
    // second round then fills that track's fields. The two enums came from the values in effect.
    expect(picked).toContainEqual(["problem_type", "build_error"]);
    expect(picked).toContainEqual(["record_type", "decision"]);
    expect(fixed.fix.needs_author).toEqual([]);
  });

  test("--pack-dir --fix --jev chooses from the pack corpus's own values", async () => {
    const root = tempRepo({
      "packs/flags/README.md": packReadme("flags"),
      "packs/flags/a.md": PACK_RULE,
      "packs/flags/b.md": PACK_RULE.replace(
        "Prefer plain flipper checks over wrappers",
        "Name flags after the behaviour",
      ),
      "packs/flags/c.md": PACK_RULE.replace(
        "Prefer plain flipper checks over wrappers",
        "Remove a flag within a sprint of rollout",
      ).replace("module: flags\n", ""),
      // A second value, so module is a choice (one distinct value never is).
      "packs/flags/d.md": PACK_RULE.replace(
        "Prefer plain flipper checks over wrappers",
        "Log every flag flip with the actor",
      ).replace("module: flags", "module: rollout"),
      ".compound-engineering/config.yaml": RECORD_TYPE_CONFIG,
    });
    const result = await runCli(
      ["audit", "--root", root, "--pack-dir", "packs", "--fix", "--jev", "--dry-run", "--json"],
      { env: withJudge },
    );
    const c = JSON.parse(result.stdout).files.find((f: { path: string }) =>
      f.path.endsWith("c.md"),
    );
    expect(c.findings.map((f: { rule: string }) => f.rule)).toEqual(["module.missing"]);
    expect(c.fix.changes).toEqual([
      expect.objectContaining({
        field: "module",
        value: "flags",
        note: "chosen among the corpus's values",
      }),
    ]);
    expect(c.fix.needs_author).toEqual([]);
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
  test("plain --fix needs no key; --fix --jev without one exits 3 before reading any file; flag pairing is checked", async () => {
    const root = tempRepo({ "docs/solutions/x.md": "not even frontmatter\n" });
    const plain = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
      env: noKey,
    });
    expect(plain.code).toBe(EXIT.FINDINGS);
    expect(JSON.parse(plain.stdout).fixers).toEqual(["deterministic"]);
    const noKeyJev = await runCli(["audit", "--root", root, "--fix", "--jev"], { env: noKey });
    expect(noKeyJev.code).toBe(EXIT.NOT_CONFIGURED);
    expect(noKeyJev.stderr).toContain("TYPESAFE_API_KEY");
    const strayJev = await runCli(["audit", "--root", root, "--jev"], { env: noKey });
    expect(strayJev.code).toBe(EXIT.USAGE);
    expect(strayJev.stderr).toContain("--jev and --model only apply with --fix");
    const modelWithoutJev = await runCli(["audit", "--root", root, "--fix", "--model", "x"], {
      env: noKey,
    });
    expect(modelWithoutJev.code).toBe(EXIT.USAGE);
    expect(modelWithoutJev.stderr).toContain("--fix --jev");
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

  test("deterministic --dry-run without a key: spelling, dates, tags, lists, titles, and quoting; Jev-only fields are named for --jev", async () => {
    const root = corpusCopy();
    const result = await runCli(["audit", "--root", root, "--fix", "--dry-run", "--json"], {
      env: noKey,
    });
    expect(result.code).toBe(EXIT.FINDINGS);
    const report = JSON.parse(result.stdout);
    expect(report.fix).toBe("dry-run");
    expect(report.fixers).toEqual(["deterministic"]);
    expect(report.thresholds).toBeNull();
    expect(report.usage).toBeNull();
    const changes = report.files.flatMap(
      (f: { fix?: { changes: Array<{ source: string; field: string }> } }) => f.fix?.changes ?? [],
    );
    expect(changes.length).toBeGreaterThan(5);
    expect(changes.every((c: { source: string }) => c.source === "deterministic")).toBe(true);
    const fields = new Set(changes.map((c: { field: string }) => c.field));
    for (const field of ["problem_type", "date", "tags", "applies_when", "title"]) {
      expect(fields.has(field), field).toBe(true);
    }
    const bug = report.files.find((f: { path: string }) => f.path.endsWith("bug-track-missing.md"));
    expect(bug.fix.changes).toEqual([]);
    expect(bug.fix.needs_author.map((n: { field: string; reason: string }) => n.reason)).toEqual([
      "needs the judge: run --fix --jev (symptoms.missing)",
      "needs the judge: run --fix --jev (root_cause.missing)",
      "needs the judge: run --fix --jev (resolution_type.missing)",
    ]);
    // The projection is what a deterministic --yes run would leave: fewer files failing, some still.
    expect(report.summary.after_fix.files_failing).toBeLessThan(report.summary.files_failing);
    expect(report.summary.after_fix.files_failing).toBeGreaterThan(3);
  });

  test("deterministic --yes without a key writes, and a second run changes nothing", async () => {
    const root = corpusCopy();
    const first = await runCli(["audit", "--root", root, "--fix", "--yes", "--json"], {
      env: noKey,
    });
    const report = JSON.parse(first.stdout);
    expect(report.fix).toBe("applied");
    expect(report.summary.fixes_applied).toBeGreaterThan(5);
    expect(readFileSync(join(root, "docs/solutions/enum-casing.md"), "utf8")).toContain(
      "problem_type: best_practice",
    );
    expect(readFileSync(join(root, "docs/solutions/tags-scalar.md"), "utf8")).toMatch(
      /tags:\n {2}- rails/,
    );
    // Jev-only gaps stay: the bug-track learning still lacks its symptoms.
    expect(readFileSync(join(root, "docs/solutions/bug-track-missing.md"), "utf8")).not.toContain(
      "symptoms:",
    );
    const second = await runCli(["audit", "--root", root, "--fix", "--yes", "--json"], {
      env: noKey,
    });
    expect(JSON.parse(second.stdout).summary.fixes_applied).toBe(0);
    expect(second.code).toBe(first.code);
  });

  test("--fix --jev --dry-run shows every diff, writes nothing, and reports what would change and what needs an author", async () => {
    const root = corpusCopy();
    const before = Object.fromEntries(
      ["enum-casing.md", "bug-track-missing.md", "clean.md"].map((f) => [
        f,
        statSync(join(root, "docs/solutions", f)).mtimeMs,
      ]),
    );
    const result = await runCli(
      ["audit", "--root", root, "--fix", "--jev", "--dry-run", "--json"],
      { env: withJudge },
    );
    const report = JSON.parse(result.stdout);
    expect(report.fix).toBe("dry-run");
    expect(report.fixers).toEqual(["deterministic", "jev"]);
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

  test("--fix --jev --yes writes, bodies stay byte-identical, the exit code reflects what remains, and a second run changes nothing", async () => {
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

    const first = await runCli(["audit", "--root", root, "--fix", "--jev", "--yes", "--json"], {
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

    const second = await runCli(["audit", "--root", root, "--fix", "--jev", "--yes", "--json"], {
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
    writeFileSync(join(pack, "README.md"), packReadme(basename(pack)));
    writeFileSync(join(pack, "rule.md"), PACK_RULE.replace("module: flags\n", ""));
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
    const applied = await runCli(
      ["audit", "--root", root, "--packs", "--fix", "--jev", "--yes", "--json"],
      { env: withJudge },
    );
    const report = JSON.parse(applied.stdout);
    expect(report.fix).toBe("applied");
    expect(report.summary.fixes_applied).toBeGreaterThan(0);
    const needs = report.files.flatMap(
      (f: { path: string; fix?: { needs_author: Array<{ field: string }> } }) =>
        (f.fix?.needs_author ?? []).map((n) => `${f.path.split("/").pop()}:${n.field}`),
    );
    expect(needs).toContain("tables.md:applies_when");
    expect(needs).toContain("rule.md:*");
    expect(report.summary.needs_author).toBe(needs.length);
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
        "--jev",
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
      const result = await runCli(
        ["audit", "--root", root, "--fix", "--jev", "--dry-run", "--json"],
        { env: { ...withJudge, TYPESAFE_BASE_URL: rejecting.url } },
      );
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
    const result = await runCli(["audit", "--root", root, "--fix", "--jev", "--yes", "--json"], {
      env,
    });
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
