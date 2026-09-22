import { describe, expect, test } from "bun:test";
import { splitDocument } from "../src/audit/document.ts";
import {
  buildEffectiveSchema,
  DEFAULT_SCHEMA,
  fieldOf,
  tagPatternOf,
} from "../src/audit/effective-schema.ts";
import { runRules } from "../src/audit/rules.ts";
import { PROBLEM_TYPES, SUGGESTED_COMPONENTS } from "../src/audit/schema.ts";
import { type FieldDeclaration, loadCeConfig } from "../src/config/ce-config.ts";
import { tempRepo } from "./helpers/fixtures.ts";

const declare = (
  name: string,
  override: FieldDeclaration["override"],
  layer: FieldDeclaration["layer"] = "config.yaml",
): FieldDeclaration => ({ name, layer, label: `${layer}:1`, override });

const LEARNING = `---
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

function findings(text: string, declarations: FieldDeclaration[], ignore: string[] = []) {
  const { schema, errors } = buildEffectiveSchema(declarations);
  expect(errors).toEqual([]);
  return runRules(splitDocument(text), {
    path: "docs/solutions/x.md",
    kind: "solution",
    options: { schema, ignore: new Set(ignore) },
  }).map((f) => ({ rule: f.rule, severity: f.severity, source: f.source }));
}

describe("the effective schema", () => {
  test("the defaults are the plugin schema, every attribute sourced to `default`", () => {
    const problem = fieldOf(DEFAULT_SCHEMA, "solution", "problem_type");
    expect(problem?.values).toEqual([...PROBLEM_TYPES]);
    expect(problem?.closed).toBe(true);
    expect(problem?.required).toBe("always");
    expect(Object.values(problem?.sources ?? {}).every((s) => s === "default")).toBe(true);
    expect(fieldOf(DEFAULT_SCHEMA, "solution", "applies_when")?.required).toBe("recommended");
    expect(fieldOf(DEFAULT_SCHEMA, "pack_readme", "applies_when")?.minItems).toBe(3);
    expect(fieldOf(DEFAULT_SCHEMA, "pack_rule", "record_type")).toBeUndefined();
  });

  test("extend adds values to an enum; the finding for an unknown value is then the repository's", () => {
    const declarations = [declare("problem_type", { values: ["prompt_regression"] })];
    const { schema } = buildEffectiveSchema(declarations);
    const field = fieldOf(schema, "solution", "problem_type");
    expect(field?.values).toEqual([...PROBLEM_TYPES, "prompt_regression"]);
    expect(field?.sources.values).toBe("config.yaml");
    expect(field?.sources.required).toBe("default");
    const extended = LEARNING.replace(
      "problem_type: best_practice",
      "problem_type: prompt_regression",
    );
    expect(findings(extended, declarations)).toEqual([]);
    expect(findings(extended, [])).toEqual([
      { rule: "problem_type.invalid", severity: "error", source: "default" },
    ]);
    const unknown = LEARNING.replace("problem_type: best_practice", "problem_type: nonsense");
    expect(findings(unknown, declarations)).toEqual([
      { rule: "problem_type.invalid", severity: "error", source: "config.yaml" },
    ]);
  });

  test("replace uses only the repository's list; closing an open field makes the list binding", () => {
    const declarations = [
      declare("component", { mode: "replace", closed: true, values: ["brief_system", "inbox_ui"] }),
    ];
    const field = fieldOf(buildEffectiveSchema(declarations).schema, "solution", "component");
    expect(field?.values).toEqual(["brief_system", "inbox_ui"]);
    expect(field?.closed).toBe(true);
    expect(fieldOf(DEFAULT_SCHEMA, "solution", "component")?.values).toEqual([
      ...SUGGESTED_COMPONENTS,
    ]);
    // `api` is a default suggestion, so it passes the defaults and fails Cora's closed list.
    expect(findings(LEARNING, [])).toEqual([]);
    expect(findings(LEARNING, declarations)).toEqual([
      { rule: "component.invalid", severity: "error", source: "config.yaml" },
    ]);
    expect(
      findings(LEARNING.replace("component: api", "component: inbox_ui"), declarations),
    ).toEqual([]);
    // Extending without closing only adds suggestions; nothing new fails.
    expect(findings(LEARNING, [declare("component", { values: ["inbox_ui"] })])).toEqual([]);
  });

  test("a custom field carries its own type, values, requirement, and kinds", () => {
    const declarations = [
      declare("record_type", {
        type: "enum",
        values: ["decision", "rule", "observation"],
        required: true,
        kinds: ["pack_rule", "solution"],
      }),
      declare("owner", { type: "string", pattern: "^@[a-z]+$" }),
      declare("links", { type: "list", maxItems: 2 }),
    ];
    const { schema, errors } = buildEffectiveSchema(declarations);
    expect(errors).toEqual([]);
    expect(fieldOf(schema, "solution", "record_type")?.source).toBe("config.yaml");
    expect(fieldOf(schema, "pack_rule", "record_type")?.required).toBe("always");
    expect(fieldOf(schema, "pack_readme", "record_type")).toBeUndefined();
    expect(findings(LEARNING, declarations)).toEqual([
      { rule: "record_type.missing", severity: "error", source: "config.yaml" },
    ]);
    const filled = LEARNING.replace(
      "severity: medium",
      'severity: medium\nrecord_type: memo\nowner: "Kieran"\nlinks: [a, b, c]',
    );
    expect(findings(filled, declarations)).toEqual([
      { rule: "record_type.invalid", severity: "error", source: "config.yaml" },
      { rule: "owner.invalid", severity: "error", source: "config.yaml" },
      { rule: "links.too_many", severity: "warning", source: "config.yaml" },
    ]);
  });

  test("bounds and requirements: item count, item length, tag count, required and optional", () => {
    const declarations = [
      declare("applies_when", { required: true, maxItems: 2, maxChars: 40 }),
      declare("tags", { maxItems: 1, required: false }),
      declare("symptoms", { minItems: 2 }),
    ];
    const three = LEARNING.replace(
      "applies_when:\n",
      'applies_when:\n  - "Retrying a request that the upstream API rate limited with a 429"\n  - "Choosing the backoff curve for a flaky third-party endpoint"\n',
    );
    expect(findings(three, declarations)).toEqual([
      { rule: "applies_when.too_many", severity: "warning", source: "config.yaml" },
      { rule: "applies_when.item_too_long", severity: "warning", source: "config.yaml" },
      { rule: "applies_when.item_too_long", severity: "warning", source: "config.yaml" },
      { rule: "applies_when.item_too_long", severity: "warning", source: "config.yaml" },
      { rule: "tags.too_many", severity: "warning", source: "config.yaml" },
    ]);
    // Required turns the schema's warning into an error; optional silences it.
    const bare = LEARNING.replace(/applies_when:[\s\S]*?tags: \[retry, backoff\]\n/, "");
    expect(findings(bare, declarations)).toEqual([
      { rule: "applies_when.missing", severity: "error", source: "config.yaml" },
    ]);
    expect(findings(bare, [])).toEqual([
      { rule: "applies_when.missing", severity: "warning", source: "default" },
      { rule: "tags.missing", severity: "warning", source: "default" },
    ]);
    const oneSymptom = LEARNING.replace("severity: medium", "severity: medium\nsymptoms: [Slow]");
    expect(findings(oneSymptom, [declare("symptoms", { minItems: 2 })])).toEqual([
      { rule: "symptoms.too_few", severity: "error", source: "config.yaml" },
    ]);
  });

  test("config.local.yaml layers over config.yaml: scalars replace, values accumulate, replace resets", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": [
        "compound:",
        "  schema:",
        "    fields:",
        "      tags:",
        "        max_items: 4",
        '        pattern: "^[a-z][a-z_]*$"',
        "      problem_type:",
        "        values: [shared_value]",
        "      component:",
        "        values: [shared_component]",
        "        closed: true",
        "  audit:",
        "    exclude: [docs/solutions/index.md]",
        "    ignore: [title.weak]",
        "",
      ].join("\n"),
      ".compound-engineering/config.local.yaml": [
        "compound:",
        "  schema:",
        "    fields:",
        "      tags:",
        "        max_items: 6",
        "      problem_type:",
        "        values: [local_value]",
        "      component:",
        "        mode: replace",
        "        values: [local_only]",
        "  audit:",
        "    exclude: [docs/solutions/other.md]",
        "    strict: true",
        "",
      ].join("\n"),
    });
    const config = loadCeConfig(root).compound;
    expect(config.errors).toEqual([]);
    expect(config.fields.map((f) => [f.name, f.layer])).toEqual([
      ["tags", "config.yaml"],
      ["problem_type", "config.yaml"],
      ["component", "config.yaml"],
      ["tags", "config.local.yaml"],
      ["problem_type", "config.local.yaml"],
      ["component", "config.local.yaml"],
    ]);
    expect(config.audit).toEqual({
      exclude: ["docs/solutions/index.md", "docs/solutions/other.md"],
      ignore: ["title.weak"],
      packDirs: [],
      strict: true,
    });
    const { schema, errors } = buildEffectiveSchema(config.fields);
    expect(errors).toEqual([]);
    const tags = fieldOf(schema, "solution", "tags");
    expect(tags?.maxItems).toBe(6);
    expect(tags?.sources.maxItems).toBe("config.local.yaml");
    expect(tags?.pattern).toBe("^[a-z][a-z_]*$");
    expect(tags?.sources.pattern).toBe("config.yaml");
    expect(tagPatternOf(schema, "solution").source).toBe("^[a-z][a-z_]*$");
    expect(fieldOf(schema, "solution", "problem_type")?.values.slice(-2)).toEqual([
      "shared_value",
      "local_value",
    ]);
    const component = fieldOf(schema, "solution", "component");
    expect(component?.values).toEqual(["local_only"]);
    expect(component?.closed).toBe(true);
    expect(component?.sources.closed).toBe("config.yaml");
    expect(component?.sources.values).toBe("config.local.yaml");
  });

  test("declarations that cannot mean anything are errors that name the line", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": [
        "compound:",
        "  schema:",
        "    fields:",
        "      problem_type:",
        "        type: string",
        "      mystery: {}",
        "      severity:",
        "        closed: false",
        "      tags:",
        "        values: [a]",
        "      date:",
        "        pattern: x",
        "      applies_when:",
        "        min_items: 6",
        "        max_items: 2",
        "      symptoms:",
        "        max_items: 0",
        "      module:",
        "        closed: true",
        "      title:",
        "        kinds: [poem]",
        "      component:",
        "        mode: replace",
        "  audit:",
        "    exclude: docs",
        "    solutions_dir: docs/solutions",
        "  bench: {}",
        "",
      ].join("\n"),
    });
    const config = loadCeConfig(root).compound;
    const { errors } = buildEffectiveSchema(config.fields);
    const all = [...config.errors, ...errors].join("\n");
    expect(all).toContain("`problem_type` is a enum field; its type cannot be changed");
    expect(all).toContain("`mystery` is not a solution field the defaults know");
    expect(all).toContain("`severity` is an enum; it cannot be opened");
    expect(all).toContain("`tags` is a list field and has no values list");
    expect(all).toContain("`date` is a date; a pattern does not apply");
    expect(all).toContain("`applies_when` has min_items above max_items");
    expect(all).toContain("`compound.schema.fields.symptoms.max_items` must be a positive integer");
    expect(all).toContain("`module` is closed but has no values");
    expect(all).toContain("`compound.schema.fields.title.kinds` must list document kinds");
    expect(all).toContain("`compound.schema.fields.component.mode` needs `values`");
    expect(all).toContain("`compound.audit.exclude:` must be a list of strings");
    expect(all).toContain("`compound.audit.solutions_dir:` is not read by this release");
    expect(all).toContain("unknown `compound.bench:`");
    expect(all).toMatch(/config\.yaml:\d+:/);
  });
});
