import type { ConfigFile, FieldDeclaration } from "../config/ce-config.ts";
import {
  LIMITS,
  PROBLEM_TYPES,
  RESOLUTION_TYPES,
  SEVERITIES,
  SUGGESTED_COMPONENTS,
  SUGGESTED_ROOT_CAUSES,
  TAG_PATTERN,
} from "./schema.ts";

/**
 * The schema the audit checks against: the CLI's defaults (the plugin schema,
 * transcribed in schema.ts today and loaded from a pinned ref in a later
 * release) with the repository's `compound.schema.fields` layered on top,
 * config.yaml first and config.local.yaml over it. Every attribute remembers
 * where its value came from, so a finding can say which layer set the rule.
 */

export type DocumentKind = "solution" | "pack_rule" | "pack_readme";
export const DOCUMENT_KINDS: readonly DocumentKind[] = ["solution", "pack_rule", "pack_readme"];

export type Source = "default" | ConfigFile;

export type FieldType = "string" | "enum" | "list" | "date";

/**
 * `always`: missing is an error. `bug`: an error on bug-track learnings only.
 * `recommended`: a warning. `never`: optional.
 */
export type Requirement = "always" | "bug" | "recommended" | "never";

export type FieldSpec = {
  type: FieldType;
  /** Enum and closed fields: the allowed values. Open string fields: suggestions the Jev fixer may offer. */
  values: string[];
  /** Only `values` pass. Always true for enums; a repository may close an open field. */
  closed: boolean;
  required: Requirement;
  /** Present on a knowledge-track learning is an error. */
  bugOnly: boolean;
  minItems: number | null;
  maxItems: number | null;
  /** Lists: the longest item the judge reads. */
  maxChars: number | null;
  /** Regex source a string value, or each list item, must match. */
  pattern: string | null;
};

export type Attribute = keyof FieldSpec;

export type EffectiveField = FieldSpec & {
  name: string;
  /** Where the field itself was declared: the defaults, or the layer that added a custom field. */
  source: Source;
  /** Where each attribute's current value came from. */
  sources: Record<Attribute, Source>;
};

/** Per document kind, the fields in check order. */
export type EffectiveSchema = Record<DocumentKind, EffectiveField[]>;

type Partial_ = Partial<FieldSpec> & { type: FieldType };

// Every build gets its own arrays: an override must never reach the module-level defaults.
const base = (spec: Partial_): FieldSpec => ({
  closed: spec.type === "enum",
  required: "never",
  bugOnly: false,
  minItems: null,
  maxItems: null,
  maxChars: null,
  pattern: null,
  ...spec,
  values: [...(spec.values ?? [])],
});

const withSource = (name: string, spec: FieldSpec, source: Source): EffectiveField => ({
  name,
  ...spec,
  source,
  sources: {
    type: source,
    values: source,
    closed: source,
    required: source,
    bugOnly: source,
    minItems: source,
    maxItems: source,
    maxChars: source,
    pattern: source,
  },
});

const VERSION = "^\\d+\\.\\d+\\.\\d+$";

/** The plugin schema for a learning (schema.yaml at c152896), in the order findings are reported. */
const SOLUTION: Array<[string, Partial_]> = [
  ["title", { type: "string", required: "always" }],
  ["date", { type: "date", required: "always" }],
  ["problem_type", { type: "enum", values: [...PROBLEM_TYPES], required: "always" }],
  ["module", { type: "string", required: "always" }],
  ["component", { type: "string", values: [...SUGGESTED_COMPONENTS], required: "always" }],
  ["severity", { type: "enum", values: [...SEVERITIES], required: "always" }],
  [
    "symptoms",
    { type: "list", required: "bug", maxItems: LIMITS.symptomsMax, maxChars: LIMITS.itemChars },
  ],
  ["root_cause", { type: "string", values: [...SUGGESTED_ROOT_CAUSES], required: "bug" }],
  ["resolution_type", { type: "enum", values: [...RESOLUTION_TYPES], required: "bug" }],
  ["rails_version", { type: "string", bugOnly: true, pattern: VERSION }],
  ["framework_version", { type: "string", bugOnly: true }],
  [
    "applies_when",
    {
      type: "list",
      required: "recommended",
      maxItems: LIMITS.appliesWhenMax,
      maxChars: LIMITS.itemChars,
    },
  ],
  [
    "tags",
    {
      type: "list",
      required: "recommended",
      maxItems: LIMITS.tagsMax,
      maxChars: LIMITS.itemChars,
      pattern: TAG_PATTERN.source,
    },
  ],
];

/** compound-packs' rule set for a top-level pack rule: what discovery and the judge read. */
const PACK_RULE: Array<[string, Partial_]> = [
  ["title", { type: "string", required: "always" }],
  [
    "applies_when",
    {
      type: "list",
      required: "always",
      minItems: 1,
      maxItems: LIMITS.packAppliesWhenMax,
      maxChars: LIMITS.itemChars,
    },
  ],
  [
    "tags",
    {
      type: "list",
      required: "always",
      minItems: 1,
      maxItems: LIMITS.tagsMax,
      maxChars: LIMITS.itemChars,
      pattern: TAG_PATTERN.source,
    },
  ],
  ["module", { type: "string", required: "always" }],
  ["problem_type", { type: "enum", values: [...PROBLEM_TYPES], required: "always" }],
];

/** A pack README: the card `packs suggest` judges the whole pack from. */
const PACK_README: Array<[string, Partial_]> = [
  ["title", { type: "string", required: "always" }],
  [
    "applies_when",
    {
      type: "list",
      required: "always",
      minItems: LIMITS.packReadmeAppliesWhenMin,
      maxItems: LIMITS.packAppliesWhenMax,
      maxChars: LIMITS.itemChars,
    },
  ],
  [
    "tags",
    {
      type: "list",
      required: "always",
      minItems: 1,
      maxItems: LIMITS.tagsMax,
      maxChars: LIMITS.itemChars,
      pattern: TAG_PATTERN.source,
    },
  ],
];

function defaults(): EffectiveSchema {
  const build = (fields: Array<[string, Partial_]>) =>
    fields.map(([name, spec]) => withSource(name, base(spec), "default"));
  return {
    solution: build(SOLUTION),
    pack_rule: build(PACK_RULE),
    pack_readme: build(PACK_README),
  };
}

export const DEFAULT_SCHEMA: EffectiveSchema = defaults();

export type SchemaBuild = { schema: EffectiveSchema; errors: string[] };

/**
 * Layer the repository's field declarations over the defaults. A declaration
 * without `kinds` applies to learnings. `values` extend the field's list unless
 * `mode: replace`; `type` is only for fields the defaults do not know. A
 * declaration with an error changes nothing; the caller refuses to run on any.
 */
export function buildEffectiveSchema(declarations: FieldDeclaration[]): SchemaBuild {
  const schema = defaults();
  const errors: string[] = [];
  for (const declaration of declarations) {
    const { name, layer, label, override } = declaration;
    const kinds = override.kinds ?? ["solution"];
    for (const kind of kinds) {
      const fields = schema[kind];
      const existing = fields.find((f) => f.name === name);
      if (!existing && override.type === undefined) {
        errors.push(
          `${label}: \`${name}\` is not a ${kind} field the defaults know; a custom field needs \`type:\` (string, enum, list, date)`,
        );
        continue;
      }
      if (existing && override.type !== undefined && override.type !== existing.type) {
        errors.push(
          `${label}: \`${name}\` is a ${existing.type} field; its type cannot be changed (drop \`type:\`)`,
        );
        continue;
      }
      const field = existing ?? withSource(name, base({ type: override.type as FieldType }), layer);
      const next = applyOverride(field, override, layer, label, errors);
      if (!next) continue;
      if (existing) Object.assign(existing, next);
      else fields.push(next);
    }
  }
  return { schema, errors };
}

/** The field with the override applied, or undefined (and an error) when it cannot mean anything. */
function applyOverride(
  current: EffectiveField,
  override: FieldDeclaration["override"],
  layer: ConfigFile,
  label: string,
  errors: string[],
): EffectiveField | undefined {
  // Work on a copy: a declaration that turns out to be an error must leave the schema as it was.
  const field: EffectiveField = {
    ...current,
    values: [...current.values],
    sources: { ...current.sources },
  };
  const fail = (message: string): undefined => {
    errors.push(`${label}: \`${field.name}\` ${message}`);
    return undefined;
  };
  const set = <A extends Attribute>(attribute: A, value: FieldSpec[A]) => {
    (field as FieldSpec)[attribute] = value;
    field.sources[attribute] = layer;
  };
  if (override.values !== undefined) {
    if (field.type === "list" || field.type === "date") {
      return fail(`is a ${field.type} field and has no values list`);
    }
    const merged =
      override.mode === "replace"
        ? [...override.values]
        : [...field.values, ...override.values.filter((v) => !field.values.includes(v))];
    set("values", merged);
  }
  if (override.closed !== undefined) {
    if (field.type === "enum" && !override.closed) return fail("is an enum; it cannot be opened");
    if (field.type === "list" || field.type === "date") {
      return fail(`is a ${field.type} field; \`closed\` applies to values`);
    }
    set("closed", override.closed);
  }
  if (field.closed && field.values.length === 0) return fail("is closed but has no values");
  if (override.required !== undefined) set("required", override.required ? "always" : "never");
  for (const attribute of ["minItems", "maxItems", "maxChars"] as const) {
    const value = override[attribute];
    if (value === undefined) continue;
    if (field.type !== "list") return fail(`is not a list; ${snake(attribute)} does not apply`);
    set(attribute, value);
  }
  if (field.minItems !== null && field.maxItems !== null && field.minItems > field.maxItems) {
    return fail("has min_items above max_items");
  }
  if (override.pattern !== undefined) {
    if (field.type === "enum" || field.type === "date") {
      return fail(`is ${field.type === "enum" ? "an enum" : "a date"}; a pattern does not apply`);
    }
    set("pattern", override.pattern);
  }
  return field;
}

function snake(attribute: string): string {
  return attribute.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function fieldOf(
  schema: EffectiveSchema,
  kind: DocumentKind,
  name: string,
): EffectiveField | undefined {
  return schema[kind].find((f) => f.name === name);
}

/** The compiled tag pattern for a kind (the default when the repository set none). */
export function tagPatternOf(schema: EffectiveSchema, kind: DocumentKind): RegExp {
  const pattern = fieldOf(schema, kind, "tags")?.pattern;
  return pattern ? new RegExp(pattern) : TAG_PATTERN;
}
