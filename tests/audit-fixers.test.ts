import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { splitDocument } from "../src/audit/document.ts";
import { buildEffectiveSchema } from "../src/audit/effective-schema.ts";
import {
  dateFromGit,
  dateFromName,
  dateFromValue,
  deterministicFixes,
  normaliseTags,
  recoverUnsafeScalars,
} from "../src/audit/fixers/deterministic.ts";
import { CANDIDATE_MAX, extractSituations, extractSymptoms } from "../src/audit/fixers/extract.ts";
import { documentView, jevFixes, THRESHOLDS } from "../src/audit/fixers/jev.ts";
import { runRules } from "../src/audit/rules.ts";
import { PROBLEM_TYPES } from "../src/audit/schema.ts";
import type { Vocabulary } from "../src/audit/vocabulary.ts";
import { rewriteFrontmatter, unifiedDiff } from "../src/audit/writer.ts";
import type { Judge } from "../src/judge/client.ts";
import { auditChoiceRequest, auditNoulRequest } from "../src/judge/questions.ts";
import { UsageTracker } from "../src/judge/usage.ts";
import { tempDir, tempRepo } from "./helpers/fixtures.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures/audit/docs/solutions");
const NO_GIT = { absPath: "/nowhere/x.md", path: "docs/solutions/x.md", git: false as const };

function fixture(name: string) {
  const raw = readFileSync(join(FIXTURES, name), "utf8");
  const doc = splitDocument(raw);
  return {
    raw,
    doc,
    findings: runRules(doc, { path: `docs/solutions/${name}`, kind: "solution" }),
  };
}

const VOCABULARY: Vocabulary = {
  module: ["http", "sync"],
  component: ["api", "background_job"],
  root_cause: [],
  tags: ["retry", "backoff", "sync"],
  enum_usage: { problem_type: { best_practice: 3 }, severity: { low: 2 }, resolution_type: {} },
  usage: { module: { http: 3, sync: 1 }, component: { api: 3, background_job: 1 }, root_cause: {} },
};

/** A judge whose answers are scripted per question key pattern. */
function scriptedJudge(
  script: (key: string, question: unknown) => unknown,
): Judge & { asked: Questions[] } {
  const asked: Questions[] = [];
  return {
    model: "scripted",
    usage: new UsageTracker(),
    asked,
    async ask(_state, questions) {
      asked.push(questions);
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(questions)) answers[key] = script(key, question);
      return answers as Awaited<ReturnType<Judge["ask"]>>;
    },
  };
}

const choiceAnswer = (choice: string, probability: number) => ({
  type: "choice",
  choice,
  confidence: probability,
  probabilities: { [choice]: probability },
});
const noulAnswer = (noul: number) => ({ type: "noul", noul });

describe("deterministic fixers", () => {
  test("title from the first heading", () => {
    const { doc, findings } = fixture("title-missing.md");
    expect(deterministicFixes(doc, findings, NO_GIT)).toEqual([
      {
        field: "title",
        value: "A heading that can become the title",
        source: "deterministic",
        note: "from the first heading",
      },
    ]);
  });

  test("date from the file name, from a loosely written value, and from git history", () => {
    expect(dateFromName("docs/solutions/x-20260115.md")).toBe("2026-01-15");
    expect(dateFromName("docs/solutions/2026-02-24-thing.md")).toBe("2026-02-24");
    expect(dateFromName("docs/solutions/no-date.md")).toBeUndefined();
    expect(dateFromValue("2026/1/5")).toBe("2026-01-05");
    expect(dateFromValue("20260105")).toBe("2026-01-05");
    expect(dateFromValue(new Date("2026-01-05T00:00:00Z"))).toBeUndefined();
    expect(dateFromValue("2026-01-05")).toBeUndefined();

    const named = fixture("date-missing-20260115.md");
    expect(
      deterministicFixes(named.doc, named.findings, {
        ...NO_GIT,
        path: "docs/solutions/date-missing-20260115.md",
      }),
    ).toEqual([
      { field: "date", value: "2026-01-15", source: "deterministic", note: "from the file name" },
    ]);
    const invalid = fixture("date-invalid.md");
    expect(deterministicFixes(invalid.doc, invalid.findings, NO_GIT)[0]).toMatchObject({
      field: "date",
      value: "2026-01-15",
    });

    const repo = tempRepo({
      "docs/solutions/undated.md": "---\ntitle: Undated learning about things\n---\n# U\n",
    });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd: repo,
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "add", "--date", "2025-12-31T12:00:00");
    expect(dateFromGit(join(repo, "docs/solutions/undated.md"))).toBe("2025-12-31");
    expect(dateFromGit("/nowhere/x.md")).toBeUndefined();
  });

  test("enum spelling", () => {
    const { doc, findings } = fixture("enum-casing.md");
    expect(deterministicFixes(doc, findings, NO_GIT)).toEqual([
      {
        field: "problem_type",
        value: "best_practice",
        source: "deterministic",
        note: "normalised the spelling",
      },
      {
        field: "severity",
        value: "high",
        source: "deterministic",
        note: "normalised the spelling",
      },
    ]);
  });

  test("tags: a comma scalar, a space scalar, casing, duplicates, and the cap", () => {
    expect(normaliseTags("Rails, Active Record, rails")).toEqual(["rails", "active-record"]);
    expect(normaliseTags("retry backoff")).toEqual(["retry", "backoff"]);
    expect(normaliseTags(["A", "b", "c", "d", "e", "f", "g", "h", "i"])).toHaveLength(8);
    const { doc, findings } = fixture("tags-too-many.md");
    const change = deterministicFixes(doc, findings, NO_GIT).find((c) => c.field === "tags");
    expect(change?.value).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  test("a scalar applies_when becomes a list; duplicates are removed", () => {
    const scalar = splitDocument(
      "---\ntitle: Scalar situation learning here\napplies_when: Adding retry with backoff to a throttled client\n---\nbody\n",
    );
    const changes = deterministicFixes(
      scalar,
      runRules(scalar, { path: "x.md", kind: "solution" }),
      NO_GIT,
    );
    expect(changes.find((c) => c.field === "applies_when")?.value).toEqual([
      "Adding retry with backoff to a throttled client",
    ]);
    const { doc, findings } = fixture("list-duplicates.md");
    const changes2 = deterministicFixes(doc, findings, NO_GIT);
    expect(changes2.find((c) => c.field === "tags")?.value).toEqual(["retry"]);
    expect(changes2.find((c) => c.field === "applies_when")?.value).toHaveLength(2);
  });

  test("bare YAML literals are put back as strings and written quoted, once", () => {
    const text =
      '---\ntitle: true\ndate: 2026-01-01\nmodule: 123\ncomponent: api\nproblem_type: best_practice\nseverity: low\napplies_when:\n  - "Adding retry with backoff to an HTTP client that gets throttled"\ntags: [inbox, null, yes]\n---\n# Title\n';
    const doc = splitDocument(text);
    const findings = runRules(doc, { path: "docs/solutions/x.md", kind: "solution" });
    expect(
      findings.filter((f) => f.rule === "frontmatter.bare_literal").map((f) => f.field),
    ).toEqual(["title", "module", "tags", "tags"]);
    expect(findings.map((f) => f.rule)).toContain("tags.not_strings");
    const changes = deterministicFixes(doc, findings, NO_GIT);
    expect(changes.map((c) => [c.field, c.value])).toEqual([
      ["title", "true"],
      ["module", "123"],
      ["tags", ["inbox", "null", "yes"]],
    ]);
    const rewritten = rewriteFrontmatter(doc, changes);
    expect(rewritten.frontmatterText).toContain('title: "true"');
    expect(rewritten.frontmatterText).toContain('module: "123"');
    expect(rewritten.frontmatterText).toContain('tags: [inbox, "null", "yes"]');
    const again = splitDocument(rewritten.text);
    expect(again.data.title).toBe("true");
    expect(again.data.tags).toEqual(["inbox", "null", "yes"]);
    // Idempotent: nothing left to fix, nothing changes on a second pass.
    const remaining = runRules(again, { path: "docs/solutions/x.md", kind: "solution" });
    expect(remaining.map((f) => f.rule)).toEqual(["title.weak"]);
    expect(deterministicFixes(again, remaining, NO_GIT)).toEqual([]);
  });

  test("a value cut at ' #' is recovered from the raw text and quoted", () => {
    expect(
      recoverUnsafeScalars(
        "title: Retry budget #2 for the client\ntags:\n  - retry #1\n  - safe\nsafe: yes",
        { title: "Retry budget", tags: ["retry", "safe"], safe: true },
      ),
    ).toEqual([
      ["title", "Retry budget #2 for the client"],
      ["tags", ["retry #1", "safe"]],
    ]);
    // Nested keys, block scalars, and a valid value with a trailing comment are left alone.
    expect(
      recoverUnsafeScalars(
        "meta:\n  owner: x\n  items:\n    - a #b\nnotes: |\n  - see #3\nseverity: high # TODO",
        {
          meta: { owner: "x", items: ["a"] },
          notes: "- see #3\n",
          severity: "high",
        },
      ),
    ).toEqual([["severity", "high # TODO"]]);
    const commented = splitDocument(
      "---\ntitle: A valid title with words\nseverity: high # TODO revisit\n---\nbody\n",
    );
    const changes = deterministicFixes(
      commented,
      runRules(commented, { path: "x.md", kind: "solution" }),
      NO_GIT,
    );
    expect(changes.find((c) => c.field === "severity")).toBeUndefined();
    const { doc, findings } = fixture("unsafe-scalar.md");
    const rewritten = rewriteFrontmatter(doc, deterministicFixes(doc, findings, NO_GIT));
    expect(rewritten.frontmatterText).toContain('title: "Retry budget #2 for the HTTP client"');
    expect(rewritten.frontmatterText).toContain(
      '- "Adding retry #1 to a client that gets throttled"',
    );
    expect(runRules(splitDocument(rewritten.text), { path: "x.md", kind: "solution" })).toEqual([]);
  });
});

describe("extraction", () => {
  const body = readFileSync(join(FIXTURES, "bug-track-missing.md"), "utf8").split(
    "\n---\n",
  )[1] as string;

  test("situations come from headings, openers, failure phrasing, and section leads, never fenced code", () => {
    const withFence = `${body}\n\`\`\`\nWhen this is code it must not appear\n\`\`\`\n`;
    const texts = extractSituations(withFence).map((c) => c.text);
    expect(texts).toContain(
      "When the sync job runs twice for one mailbox, the second run raises a unique index error",
    );
    expect(texts.some((t) => t.includes("must not appear"))).toBe(false);
    expect(texts.every((t) => t.length >= 6 && t.length <= 200)).toBe(true);
  });

  test("symptoms come from failure phrasing only; the cap is twelve", () => {
    const symptoms = extractSymptoms(body).map((c) => c.text);
    expect(symptoms[0]).toContain("raises a unique index error");
    expect(symptoms).not.toContain("Add a lock");
    const many = Array.from(
      { length: 40 },
      (_, i) => `When case ${i} happens the job fails loudly.`,
    ).join("\n");
    expect(extractSituations(many)).toHaveLength(CANDIDATE_MAX);
  });

  test("a body of tables yields nothing", () => {
    const table = readFileSync(join(FIXTURES, "applies-when-missing-no-prose.md"), "utf8").split(
      "\n---\n",
    )[1] as string;
    expect(extractSituations(table)).toEqual([]);
  });
});

describe("jev fixers", () => {
  test("request shapes: enum labels are schema values, corpus values are tagged and live in state, document text stays in state", () => {
    const { doc } = fixture("bug-track-missing.md");
    const view = documentView(doc, "docs/solutions/bug-track-missing.md");
    const request = auditChoiceRequest(view, [
      {
        field: "problem_type",
        options: Object.fromEntries(PROBLEM_TYPES.map((p) => [p, p])),
        tagged: false,
      },
      { field: "module", options: { v00: "http", v01: "sync" }, tagged: true },
    ]);
    const problem = request.questions.problem_type as { criteria: Record<string, string> };
    expect(Object.keys(problem.criteria)).toEqual([...PROBLEM_TYPES]);
    const moduleQuestion = request.questions.module as { criteria: Record<string, string> };
    expect(Object.keys(moduleQuestion.criteria)).toEqual(["v00", "v01"]);
    expect((request.state.vocabulary as Record<string, unknown>).module).toEqual({
      v00: "http",
      v01: "sync",
    });
    expect(JSON.stringify(request.questions)).not.toContain("unique index error");
    expect(JSON.stringify(request.state)).toContain("unique index error");

    const nouls = auditNoulRequest(view, [
      {
        field: "applies_when",
        items: { c00: "When it fails" },
        question: (tag) => `Is ${tag} a situation?`,
      },
    ]);
    expect(Object.keys(nouls.questions)).toEqual(["applies_when.c00"]);
    expect((nouls.state.candidates as Record<string, unknown>).applies_when).toEqual({
      c00: "When it fails",
    });
  });

  test("choices above the bar become changes; below the bar they go to the author", async () => {
    const { doc, findings } = fixture("vocabulary-missing.md");
    const judge = scriptedJudge((key) =>
      key === "module"
        ? choiceAnswer("v01", 0.9)
        : key === "component"
          ? choiceAnswer("v00", 0.3)
          : choiceAnswer("low", 0.8),
    );
    const result = await jevFixes(
      judge,
      doc,
      "docs/solutions/vocabulary-missing.md",
      findings,
      VOCABULARY,
    );
    expect(result.changes).toEqual([
      {
        field: "module",
        value: "sync",
        source: "jev",
        score: 0.9,
        note: "chosen among the corpus's values",
      },
      {
        field: "severity",
        value: "low",
        source: "jev",
        score: 0.8,
        note: "chosen among the schema's values",
      },
    ]);
    expect(result.needsAuthor).toEqual([
      {
        field: "component",
        reason: `the judge's best answer (api) was only 0.3, under ${THRESHOLDS.choice}`,
      },
    ]);
    expect(judge.asked).toHaveLength(1);
  });

  test("a repository's own list is what the judge chooses from, for a missing and for an out-of-list value", async () => {
    // Cora-style: component closed to the repository's list, and a custom enum on learnings.
    const { schema } = buildEffectiveSchema([
      {
        name: "component",
        layer: "config.yaml",
        label: "config.yaml:3",
        override: { values: ["brief_system", "email_processing"], mode: "replace", closed: true },
      },
      {
        name: "record_type",
        layer: "config.yaml",
        label: "config.yaml:9",
        override: { type: "enum", values: ["decision", "rule"], required: true },
      },
    ]);
    const doc = splitDocument(
      '---\ntitle: A learning whose component is not on the list\ndate: 2026-01-01\nmodule: inbox\ncomponent: api\nproblem_type: convention\nseverity: low\napplies_when:\n  - "Deciding where a brief\'s summary paragraph is assembled"\ntags: [inbox]\n---\n# Body\n',
    );
    const findings = runRules(doc, {
      path: "docs/solutions/x.md",
      kind: "solution",
      options: { schema, ignore: new Set() },
    });
    expect(findings.map((f) => [f.rule, f.source])).toEqual([
      ["component.invalid", "config.yaml"],
      ["record_type.missing", "config.yaml"],
    ]);
    const judge = scriptedJudge((key) =>
      key === "component" ? choiceAnswer("email_processing", 0.9) : choiceAnswer("decision", 0.8),
    );
    const result = await jevFixes(judge, doc, "x.md", findings, VOCABULARY, schema.solution);
    expect(result.changes).toEqual([
      {
        field: "component",
        value: "email_processing",
        source: "jev",
        score: 0.9,
        note: "chosen among the repository's values",
      },
      {
        field: "record_type",
        value: "decision",
        source: "jev",
        score: 0.8,
        note: "chosen among the repository's values",
      },
    ]);
    // The Choice offered exactly the repository's values, not the corpus's or the schema's suggestions.
    const asked = judge.asked[0] as Record<string, { criteria: Record<string, string> }>;
    expect(Object.keys(asked.component?.criteria ?? {})).toEqual([
      "brief_system",
      "email_processing",
    ]);
    expect(Object.keys(asked.record_type?.criteria ?? {})).toEqual(["decision", "rule"]);
  });

  test("the Jev list fixers cap at the field's effective max_items, not the schema constant", async () => {
    const { schema } = buildEffectiveSchema([
      { name: "tags", layer: "config.yaml", label: "config.yaml:1", override: { maxItems: 3 } },
    ]);
    const { doc, findings } = fixture("tags-missing.md");
    const vocabulary = {
      ...VOCABULARY,
      tags: ["retry", "backoff", "sync", "http", "jobs", "queues"],
    };
    const judge = scriptedJudge(() => noulAnswer(0.95));
    const tagsOf = (result: Awaited<ReturnType<typeof jevFixes>>) =>
      result.changes.find((c) => c.field === "tags")?.value as string[] | undefined;
    const capped = await jevFixes(judge, doc, "x.md", findings, vocabulary, schema.solution);
    expect(tagsOf(capped)).toHaveLength(3);
    // The schema's own cap still applies without an override.
    const wide = await jevFixes(judge, doc, "x.md", findings, vocabulary);
    expect(tagsOf(wide)).toHaveLength(6);
  });

  test("a corpus with one module value is not a choice", async () => {
    const { doc, findings } = fixture("vocabulary-missing.md");
    const judge = scriptedJudge(() => choiceAnswer("low", 0.9));
    const result = await jevFixes(judge, doc, "x.md", findings, {
      ...VOCABULARY,
      module: ["http"],
    });
    expect(result.needsAuthor).toContainEqual({
      field: "module",
      reason: "the corpus uses only one module value, so there is nothing to choose from",
    });
  });

  test("applies_when and symptoms keep the sentences the judge accepts and mark needs_author when none pass", async () => {
    const { doc, findings } = fixture("bug-track-missing.md");
    const accepting = scriptedJudge((key) =>
      key.startsWith("symptoms.")
        ? noulAnswer(0.9)
        : key.includes(".")
          ? noulAnswer(0.1)
          : choiceAnswer("concurrency", 0.95),
    );
    const result = await jevFixes(accepting, doc, "x.md", findings, VOCABULARY);
    const symptoms = result.changes.find((c) => c.field === "symptoms");
    expect(symptoms?.value).toEqual([
      "When the sync job runs twice for one mailbox, the second run raises a unique index error",
    ]);
    expect(result.changes.find((c) => c.field === "root_cause")?.value).toBe("concurrency");

    const generic = fixture("applies-when-generic.md");
    const rejecting = scriptedJudge(() => noulAnswer(0.2));
    const rejected = await jevFixes(rejecting, generic.doc, "x.md", generic.findings, VOCABULARY);
    expect(rejected.changes).toEqual([]);
    expect(rejected.needsAuthor[0]?.field).toBe("applies_when");
    expect(rejected.needsAuthor[0]?.reason).toContain(
      `no extracted sentence reached ${THRESHOLDS.situation}`,
    );

    const accepted = await jevFixes(
      scriptedJudge(() => noulAnswer(0.85)),
      generic.doc,
      "x.md",
      generic.findings,
      VOCABULARY,
    );
    const situations = accepted.changes.find((c) => c.field === "applies_when")?.value as string[];
    expect(situations).toContain("When the API answers 429 the client hammers it");
    expect(situations).not.toContain("always");
    expect(situations.length).toBeLessThanOrEqual(5);
  });

  test("tags come from the corpus vocabulary, keep existing valid tags, and cap at eight", async () => {
    const { doc, findings } = fixture("tags-missing.md");
    const judge = scriptedJudge((key) => (key === "tags.t00" ? noulAnswer(0.9) : noulAnswer(0.2)));
    const result = await jevFixes(judge, doc, "x.md", findings, VOCABULARY);
    expect(result.changes).toEqual([
      {
        field: "tags",
        value: ["retry"],
        source: "jev",
        score: 0.9,
        note: "1 of 3 corpus tags judged fitting",
      },
    ]);
    const empty = await jevFixes(judge, doc, "x.md", findings, { ...VOCABULARY, tags: [] });
    expect(empty.needsAuthor[0]?.reason).toContain("no tag used by two or more files");
  });
});

describe("writer", () => {
  test("golden diff for the loosely written learning", () => {
    const { doc, findings } = fixture("enum-casing.md");
    const changes = deterministicFixes(doc, findings, NO_GIT);
    const rewritten = rewriteFrontmatter(doc, changes);
    expect(
      unifiedDiff("docs/solutions/enum-casing.md", doc.frontmatterText, rewritten.frontmatterText),
    ).toBe(
      `--- a/docs/solutions/enum-casing.md
+++ b/docs/solutions/enum-casing.md
@@ -3,8 +3,8 @@
 date: 2026-01-01
 module: http
 component: api
-problem_type: Best Practice
-severity: HIGH
+problem_type: best_practice
+severity: high
 applies_when:
   - "Adding retry with backoff to an HTTP client that gets throttled"
 tags: [retry]
`,
    );
  });

  test("the body is byte-identical, comments and key order survive, CRLF and BOM are kept, and an empty block grows fields", () => {
    const crlf =
      "\uFEFF---\r\n# kept comment\r\ntitle: Something about retries here\r\nseverity: HIGH\r\n---\r\n# Body\r\n\r\n---\r\nfenced-looking line\r\n";
    const doc = splitDocument(crlf);
    const rewritten = rewriteFrontmatter(doc, [
      { field: "severity", value: "high", source: "deterministic", note: "" },
    ]);
    expect(rewritten.text.endsWith(doc.body)).toBe(true);
    expect(
      rewritten.text.startsWith(
        "\uFEFF---\r\n# kept comment\r\ntitle: Something about retries here\r\nseverity: high\r\n---\r\n",
      ),
    ).toBe(true);

    // A stray CRLF inside a LF body must not turn the whole file into CRLF.
    const mixed = splitDocument(
      "---\ntitle: Something about retries here\nseverity: HIGH\n---\n# Body\n\nline one\r\nline two\n",
    );
    expect(mixed.eol).toBe("\n");
    expect(mixed.body).toBe("# Body\n\nline one\r\nline two\n");
    expect(rewriteFrontmatter(mixed, []).text).toBe(mixed.raw);

    const empty = splitDocument("---\n---\nbody\n");
    const grown = rewriteFrontmatter(empty, [
      { field: "title", value: "New title for the learning", source: "deterministic", note: "" },
    ]);
    expect(grown.text).toBe("---\ntitle: New title for the learning\n---\nbody\n");
  });

  test("a value that needs quoting is quoted; an unchanged file diffs to nothing", () => {
    const doc = splitDocument("---\ntitle: Old\n---\nbody\n");
    const rewritten = rewriteFrontmatter(doc, [
      {
        field: "title",
        value: "A title: with a colon #and hash",
        source: "deterministic",
        note: "",
      },
    ]);
    expect(rewritten.frontmatterText).toBe('title: "A title: with a colon #and hash"');
    expect(unifiedDiff("x.md", "a\nb", "a\nb")).toBe("");
  });

  test("a fixed corpus file is idempotent through the pipeline", () => {
    const dir = tempDir("compound-cli-audit-");
    const path = join(dir, "x.md");
    const { raw } = fixture("enum-casing.md");
    writeFileSync(path, raw);
    const first = splitDocument(readFileSync(path, "utf8"));
    const changes = deterministicFixes(
      first,
      runRules(first, { path: "x.md", kind: "solution" }),
      NO_GIT,
    );
    writeFileSync(path, rewriteFrontmatter(first, changes).text);
    const second = splitDocument(readFileSync(path, "utf8"));
    const again = deterministicFixes(
      second,
      runRules(second, { path: "x.md", kind: "solution" }),
      NO_GIT,
    );
    expect(again).toEqual([]);
    expect(rewriteFrontmatter(second, []).text).toBe(readFileSync(path, "utf8"));
  });
});
