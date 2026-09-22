import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { firstHeading, splitDocument, unsafeScalars } from "../src/audit/document.ts";
import { isGenericAppliesWhen, isWeakTitle, runRules } from "../src/audit/rules.ts";
import { normalizeEnum, normalizeTag, PROBLEM_TYPES, trackOf } from "../src/audit/schema.ts";
import { buildVocabulary } from "../src/audit/vocabulary.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures/audit/docs/solutions");

const CLEAN = `---
title: Clean learning about retries with backoff
date: 2026-01-01
module: http
component: api
problem_type: best_practice
severity: medium
applies_when:
  - "Adding retry with backoff to an HTTP client that gets throttled"
tags: [retry, backoff]
---
# Clean

body
`;

function rules(
  text: string,
  path = "docs/solutions/x.md",
  kind: "solution" | "pack_rule" = "solution",
) {
  return runRules(splitDocument(text), { path, kind }).map((f) => f.rule);
}

function withFrontmatter(lines: string, body = "# Title\n\nbody\n"): string {
  return `---\n${lines}\n---\n${body}`;
}

/** The clean document with one field replaced or removed. */
function variant(field: string, replacement?: string): string {
  const lines = CLEAN.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${field}:`));
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith("  ")) end++;
  const out = [
    ...lines.slice(0, start),
    ...(replacement === undefined ? [] : [replacement]),
    ...lines.slice(end),
  ];
  return out.join("\n");
}

describe("splitDocument", () => {
  test("keeps the body byte for byte, the line ending style, and a BOM", () => {
    const text =
      "\uFEFF---\r\ntitle: X\r\n---\r\n# Body\r\n\r\n---\r\nnot a delimiter inside the body\r\n";
    const doc = splitDocument(text);
    expect(doc.bom).toBe("\uFEFF");
    expect(doc.eol).toBe("\r\n");
    expect(doc.frontmatterText).toBe("title: X");
    expect(doc.body).toBe("# Body\r\n\r\n---\r\nnot a delimiter inside the body\r\n");
    expect(doc.data).toEqual({ title: "X" });
  });

  test("a missing block, an unterminated block, and a non-mapping block are told apart", () => {
    expect(splitDocument("no block\n").hasFrontmatter).toBe(false);
    expect(splitDocument("---\ntitle: X\n").unterminated).toBe(true);
    expect(splitDocument("---\n- a\n- b\n---\nbody\n").parseError).toBe(
      "frontmatter is not a mapping",
    );
    expect(splitDocument("---\ntitle: [\n---\nbody\n").parseError).toMatch(
      /invalid frontmatter YAML/,
    );
    expect(splitDocument("---\n---\nbody\n").data).toEqual({});
  });

  test("unsafe scalars: ' #', ': ', and a leading reserved indicator, unquoted only", () => {
    const bad = unsafeScalars(
      'title: Retry budget #2\nnote: a: b\nlist:\n  - `code` first\n  - "quoted #ok"\nfine: yes',
    );
    expect(bad).toEqual(["title: Retry budget #2", "note: a: b", "- `code` first"]);
  });

  test("the first H1 outside code fences becomes a title candidate", () => {
    expect(firstHeading("```\n# not this\n```\n# **This one**\n")).toBe("This one");
    expect(firstHeading("# framer-motion: always use `m.*`, never `motion.*`\n")).toBe(
      "framer-motion: always use `m.*`, never `motion.*`",
    );
    expect(firstHeading("# **a** and **b**\n")).toBe("**a** and **b**");
    expect(firstHeading("# __whole heading__\n")).toBe("whole heading");
    expect(firstHeading("no heading")).toBeUndefined();
  });
});

describe("schema helpers", () => {
  test("enum normalisation accepts case, whitespace, and hyphen variants and rejects the rest", () => {
    expect(normalizeEnum("Best Practice", PROBLEM_TYPES)).toBe("best_practice");
    expect(normalizeEnum(" ui-bug ", PROBLEM_TYPES)).toBe("ui_bug");
    expect(normalizeEnum("bestpractice", PROBLEM_TYPES)).toBeNull();
    expect(normalizeEnum(42, PROBLEM_TYPES)).toBeNull();
  });

  test("tracks follow the schema's two lists", () => {
    expect(trackOf("runtime_error")).toBe("bug");
    expect(trackOf("convention")).toBe("knowledge");
    expect(trackOf("nonsense")).toBeNull();
  });

  test("tag normalisation lowercases, hyphenates, and strips what the pattern forbids", () => {
    expect(normalizeTag(" Active Record ")).toBe("active-record");
    expect(normalizeTag("Rails_7.1")).toBe("rails-7.1");
    expect(normalizeTag("--weird--")).toBe("weird");
  });
});

describe("each rule fires on its fixture and nothing else", () => {
  test("a clean learning has no findings", () => {
    expect(rules(CLEAN)).toEqual([]);
  });

  test("frontmatter shape", () => {
    expect(rules("body only\n")).toEqual(["frontmatter.missing"]);
    expect(rules("---\ntitle: X\n")).toEqual(["frontmatter.unterminated"]);
    expect(rules("---\ntitle: [\n---\nbody\n")).toEqual(["frontmatter.invalid_yaml"]);
    const unsafe = rules(variant("title", "title: Retry budget #2 for the client"));
    expect(unsafe).toContain("frontmatter.unsafe_scalar");
  });

  test("title", () => {
    expect(rules(variant("title"))).toEqual(["title.missing"]);
    expect(rules(variant("title", "title: Notes"))).toEqual(["title.weak"]);
    expect(
      rules(
        variant("title", "title: Retry with backoff"),
        "docs/solutions/retry-with-backoff-20260101.md",
      ),
    ).toEqual(["title.weak"]);
    expect(isWeakTitle("Give the CLI a distinct exit code", "docs/solutions/x.md")).toBe(false);
  });

  test("date", () => {
    expect(rules(variant("date"))).toEqual(["date.missing"]);
    expect(rules(variant("date", "date: 2026/01/15"))).toEqual(["date.invalid"]);
    expect(rules(variant("date", "date: 2026-01-15"))).toEqual([]);
  });

  test("problem_type, module, component, severity", () => {
    expect(rules(variant("problem_type"))).toEqual(["problem_type.missing"]);
    expect(rules(variant("problem_type", "problem_type: Best Practice"))).toEqual([
      "problem_type.invalid",
    ]);
    expect(rules(variant("module"))).toEqual(["module.missing"]);
    expect(rules(variant("component"))).toEqual(["component.missing"]);
    expect(rules(variant("severity"))).toEqual(["severity.missing"]);
    expect(rules(variant("severity", "severity: urgent"))).toEqual(["severity.invalid"]);
  });

  test("bug-track fields are required on bug docs and harmless on knowledge docs", () => {
    const bug = variant("problem_type", "problem_type: runtime_error");
    expect(rules(bug)).toEqual([
      "symptoms.missing",
      "root_cause.missing",
      "resolution_type.missing",
    ]);
    const complete = `${bug.replace("\n---\n#", "\nsymptoms:\n  - Raises a unique index error\nroot_cause: concurrency\nresolution_type: code_fix\n---\n#")}`;
    expect(rules(complete)).toEqual([]);
    expect(
      rules(complete.replace("resolution_type: code_fix", "resolution_type: patched")),
    ).toEqual(["resolution_type.invalid"]);
    const knowledgeWithBugFields = CLEAN.replace(
      "\n---\n#",
      "\nsymptoms:\n  - Friction noticed\nresolution_type: code_fix\n---\n#",
    );
    expect(rules(knowledgeWithBugFields)).toEqual([]);
  });

  test("applies_when: missing, empty, scalar, generic, too many, too long", () => {
    expect(rules(variant("applies_when"))).toEqual(["applies_when.missing"]);
    expect(rules(variant("applies_when", "applies_when: []"))).toEqual(["applies_when.missing"]);
    expect(
      rules(
        variant("applies_when", "applies_when: Adding retry with backoff to a throttled client"),
      ),
    ).toEqual(["applies_when.not_a_list"]);
    expect(
      rules(
        variant(
          "applies_when",
          'applies_when:\n  - always\n  - "Clean learning about retries with backoff"',
        ),
      ),
    ).toEqual(["applies_when.generic"]);
    expect(
      rules(
        variant(
          "applies_when",
          `applies_when:\n${Array.from({ length: 6 }, (_, i) => `  - "Situation number ${i} where this learning applies"`).join("\n")}`,
        ),
      ),
    ).toEqual(["applies_when.too_many"]);
    expect(rules(variant("applies_when", `applies_when:\n  - "${"long ".repeat(70)}"`))).toEqual([
      "applies_when.item_too_long",
    ]);
  });

  test("generic applies_when: placeholders, under four words, title restatements", () => {
    expect(isGenericAppliesWhen("always", "T")).toBe(true);
    expect(isGenericAppliesWhen("When working on this codebase", "T")).toBe(true);
    expect(isGenericAppliesWhen("Adding retries", "T")).toBe(true);
    expect(
      isGenericAppliesWhen(
        "Retries with backoff for HTTP clients",
        "Retries with backoff for HTTP clients",
      ),
    ).toBe(true);
    expect(
      isGenericAppliesWhen(
        "Adding retry with backoff to a throttled HTTP client",
        "Some other title",
      ),
    ).toBe(false);
  });

  test("tags: missing, scalar, format, too many, duplicates", () => {
    expect(rules(variant("tags"))).toEqual(["tags.missing"]);
    expect(rules(variant("tags", "tags: Rails, Active Record"))).toEqual(["tags.not_a_list"]);
    expect(rules(variant("tags", "tags: [Rails]"))).toEqual(["tags.format"]);
    expect(rules(variant("tags", `tags: [${"abcdefghi".split("").join(", ")}]`))).toEqual([
      "tags.too_many",
    ]);
    expect(rules(variant("tags", "tags: [retry, Retry]"))).toEqual([
      "tags.format",
      "list.duplicate",
    ]);
  });

  test("pack rules use the packs validator's rule set", () => {
    const rule = withFrontmatter(
      'title: Prefer plain flipper checks\napplies_when:\n  - "Deciding how to gate a feature behind a flag"\ntags: [flipper]\nmodule: flags\nproblem_type: convention\nrecord_type: rule',
    );
    expect(rules(rule, "pack/rule.md", "pack_rule")).toEqual([]);
    expect(
      rules(rule.replace("record_type: rule", "record_type: note"), "pack/rule.md", "pack_rule"),
    ).toEqual(["record_type.invalid"]);
    expect(rules(rule.replace("tags: [flipper]\n", ""), "pack/rule.md", "pack_rule")).toEqual([
      "tags.missing",
    ]);
    // Pack rules need no date, component, or severity.
    expect(rules(rule, "pack/rule.md", "pack_rule")).not.toContain("date.missing");
  });
});

describe("the fixture corpus covers every failure class", () => {
  test("each fixture file fires the rule its name promises", () => {
    const expected: Record<string, string> = {
      "missing-frontmatter.md": "frontmatter.missing",
      "unterminated.md": "frontmatter.unterminated",
      "invalid-yaml.md": "frontmatter.invalid_yaml",
      "unsafe-scalar.md": "frontmatter.unsafe_scalar",
      "title-missing.md": "title.missing",
      "title-weak.md": "title.weak",
      "date-missing-20260115.md": "date.missing",
      "date-invalid.md": "date.invalid",
      "enum-casing.md": "problem_type.invalid",
      "problem-type-missing.md": "problem_type.missing",
      "vocabulary-missing.md": "module.missing",
      "bug-track-missing.md": "symptoms.missing",
      "applies-when-generic.md": "applies_when.generic",
      "applies-when-missing-no-prose.md": "applies_when.missing",
      "tags-scalar.md": "tags.not_a_list",
      "tags-too-many.md": "tags.too_many",
      "tags-missing.md": "tags.missing",
      "list-duplicates.md": "list.duplicate",
    };
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".md"));
    expect(files.sort()).toEqual([...Object.keys(expected), "clean.md"].sort());
    for (const [name, rule] of Object.entries(expected)) {
      const found = rules(readFileSync(join(FIXTURES, name), "utf8"), `docs/solutions/${name}`);
      expect(found, name).toContain(rule);
    }
    expect(rules(readFileSync(join(FIXTURES, "clean.md"), "utf8"))).toEqual([]);
  });

  test("the vocabulary ranks corpus values by use and keeps tags used twice or more", () => {
    const docs = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".md"))
      .map((f) => splitDocument(readFileSync(join(FIXTURES, f), "utf8")));
    const vocabulary = buildVocabulary(docs);
    expect(vocabulary.module[0]).toBe("http");
    expect(vocabulary.component).toContain("api");
    expect(vocabulary.tags[0]).toBe("retry");
    expect(vocabulary.tags).not.toContain("yaml");
  });
});
