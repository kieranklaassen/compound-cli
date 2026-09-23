import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from "yaml";
import { DOCUMENT_KINDS, type DocumentKind, type FieldType } from "../audit/effective-schema.ts";
import { UsageError } from "../errors.ts";

export const CONFIG_DIR = ".compound-engineering";
/** Layer order matters: config.yaml entries precede config.local.yaml (first declaration wins). */
export const CONFIG_FILES = ["config.yaml", "config.local.yaml"] as const;
export type ConfigFile = (typeof CONFIG_FILES)[number];

export const PACK_ENTRY_KEYS = new Set(["source", "ref", "path", "pack", "id"]);

export type PackEntry = {
  source?: string;
  ref?: string;
  path?: string;
  pack?: string | string[];
  id?: string;
  /** `config.yaml:12`, used verbatim in warnings and errors. */
  label: string;
};

export type PackSourceEntry = {
  source: string;
  ref?: string;
  path?: string;
  label: string;
};

/**
 * One field in `compound.schema.fields`: how this repository narrows, extends,
 * or adds to the CLI's default schema. Attributes left out keep their default.
 */
export type FieldOverride = {
  /** Custom fields only: what the field holds. */
  type?: FieldType;
  /** Enum, closed, or suggested values; `mode` says how they combine with the defaults. */
  values?: string[];
  /** `extend` adds to the default list (the default); `replace` uses only this list. */
  mode?: "extend" | "replace";
  /** Close an open field so only `values` pass. */
  closed?: boolean;
  /** true: a missing value is an error; false: the field is optional. */
  required?: boolean;
  minItems?: number;
  maxItems?: number;
  maxChars?: number;
  /** Regex source a string value, or each list item, must match. */
  pattern?: string;
  /** Which document kinds the declaration applies to; learnings when left out. */
  kinds?: DocumentKind[];
};

export type FieldDeclaration = {
  name: string;
  layer: ConfigFile;
  /** `config.yaml:12`, used verbatim in errors. */
  label: string;
  override: FieldOverride;
};

/**
 * Everything only the CLI reads, under one `compound:` key so it never collides
 * with the plugin's own keys. `schema.fields` layers the repository's schema
 * over the defaults; `audit` says what to leave out and how to run.
 */
export type CompoundConfig = {
  /** In layer order: config.yaml's declarations, then config.local.yaml's. */
  fields: FieldDeclaration[];
  audit: {
    /** Repo-relative files (or directories, with a trailing slash) under solutions/ that are not learnings. */
    exclude: string[];
    /** Rule ids dropped from the report. */
    ignore: string[];
    /** Repo-relative directories of packs to audit in pack-authoring mode (`--pack-dir`). */
    packDirs: string[];
    /** The default for `--strict` in this repository. */
    strict: boolean;
  };
  /** Problems in the `compound:` block; the audit refuses to run with any. */
  errors: string[];
};

export const EMPTY_COMPOUND_CONFIG: CompoundConfig = {
  fields: [],
  audit: { exclude: [], ignore: [], packDirs: [], strict: false },
  errors: [],
};

export type CeConfig = {
  repoRoot: string;
  /** Repo-relative artifact root, `docs` by default. */
  docsRoot: string;
  docsRootAbs: string;
  docsRootSource: ConfigFile | "default";
  packs: PackEntry[];
  packSources: PackSourceEntry[];
  compound: CompoundConfig;
  errors: string[];
};

type Layer = { file: ConfigFile; doc: ReturnType<typeof parseDocument>; lines: LineCounter };

export function loadCeConfig(repoRoot: string): CeConfig {
  const layers: Layer[] = [];
  const errors: string[] = [];
  for (const file of CONFIG_FILES) {
    const path = join(repoRoot, CONFIG_DIR, file);
    if (!existsSync(path)) continue;
    const lines = new LineCounter();
    const doc = parseDocument(readFileSync(path, "utf8"), {
      lineCounter: lines,
      keepSourceTokens: false,
    });
    for (const issue of doc.errors) errors.push(`${file}: ${issue.message.split("\n")[0]}`);
    layers.push({ file, doc, lines });
  }

  const docsRootPick = pickDocsRoot(layers);
  const docsRoot = docsRootPick?.value ?? "docs";
  const docsRootAbs = validateDocsRoot(repoRoot, docsRoot, docsRootPick?.file);

  const packs: PackEntry[] = [];
  const packSources: PackSourceEntry[] = [];
  const compound: CompoundConfig = {
    fields: [],
    audit: { exclude: [], ignore: [], packDirs: [], strict: false },
    errors: [],
  };
  for (const layer of layers) {
    packs.push(...readPackEntries(layer, errors));
    packSources.push(...readPackSources(layer, errors));
    readCompoundConfig(layer, compound);
  }
  return {
    repoRoot,
    docsRoot,
    docsRootAbs,
    docsRootSource: docsRootPick?.file ?? "default",
    packs,
    packSources,
    compound,
    errors,
  };
}

/** config.local.yaml first, then config.yaml; first non-empty wins. */
function pickDocsRoot(layers: Layer[]): { value: string; file: ConfigFile } | undefined {
  for (const layer of [...layers].reverse()) {
    const node = layer.doc.get("docs_root", true);
    if (isScalar(node) && typeof node.value === "string" && node.value.trim()) {
      return { value: node.value.trim(), file: layer.file };
    }
  }
  return undefined;
}

function validateDocsRoot(
  repoRoot: string,
  docsRoot: string,
  file: ConfigFile | undefined,
): string {
  const abs = resolve(repoRoot, docsRoot);
  if (file === undefined) return abs;
  const fail = (why: string): never => {
    throw new UsageError(`docs_root ${JSON.stringify(docsRoot)} in ${file} ${why}`);
  };
  if (isAbsolute(docsRoot)) fail("must be repo-relative");
  const repoReal = realpathSync(repoRoot);
  if (!existsSync(abs)) {
    // Not created yet: validate the lexical path instead of the real one.
    const rel = relative(repoReal, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      fail("resolves outside the repository");
    if (rel === ".git" || rel.startsWith(`.git${sep}`)) fail("may not live under .git");
    return abs;
  }
  if (!statSync(abs).isDirectory()) fail("is not a directory");
  const real = realpathSync(abs);
  const rel = relative(repoReal, real);
  if (rel === "") fail("may not be the repository root");
  if (rel.startsWith("..") || isAbsolute(rel)) fail("resolves outside the repository");
  if (rel === ".git" || rel.startsWith(`.git${sep}`)) fail("may not live under .git");
  return abs;
}

function readPackEntries(layer: Layer, errors: string[]): PackEntry[] {
  const node = layer.doc.get("packs", true) as Node | undefined;
  if (node === undefined) return [];
  if (!isSeq(node)) {
    if (isScalar(node) && (node.value === null || node.value === "")) return [];
    errors.push(
      `${label(layer, node)}: \`packs:\` must be a block list of \`- source: ...\` entries`,
    );
    return [];
  }
  const entries: PackEntry[] = [];
  for (const item of node.items) {
    const where = label(layer, item as Node);
    if (!isMap(item)) {
      errors.push(`${where}: unrecognized packs entry (expected \`- source: ...\`)`);
      continue;
    }
    const entry: PackEntry = { label: where };
    let ok = true;
    for (const pair of item.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (!PACK_ENTRY_KEYS.has(key)) {
        errors.push(
          `${where}: unknown packs entry key \`${key}:\` (accepted keys: ${[...PACK_ENTRY_KEYS].sort().join(", ")})`,
        );
        ok = false;
        continue;
      }
      const value = pair.value;
      if (key === "pack") {
        if (isSeq(value)) {
          entry.pack = value.items.map((v) => (isScalar(v) ? String(v.value) : String(v)));
        } else if (isScalar(value) && value.value !== null) {
          entry.pack = String(value.value);
        } else if (isScalar(value) && value.value === null) {
          entry.pack = [];
        }
        continue;
      }
      if (!isScalar(value) || typeof value.value !== "string") {
        errors.push(`${where}: \`${key}:\` must be a single string`);
        ok = false;
        continue;
      }
      entry[key as "source" | "ref" | "path" | "id"] = value.value;
    }
    if (ok) entries.push(entry);
  }
  return entries;
}

function readPackSources(layer: Layer, errors: string[]): PackSourceEntry[] {
  const node = layer.doc.get("pack_sources", true) as Node | undefined;
  if (node === undefined) return [];
  if (!isSeq(node)) {
    errors.push(
      `${label(layer, node)}: \`pack_sources:\` must be a list of \`- source: ...\` entries`,
    );
    return [];
  }
  const entries: PackSourceEntry[] = [];
  for (const item of node.items) {
    const where = label(layer, item as Node);
    if (!isMap(item)) {
      errors.push(`${where}: unrecognized pack_sources entry (expected \`- source: ...\`)`);
      continue;
    }
    const source = item.get("source");
    if (typeof source !== "string" || !source.trim()) {
      errors.push(`${where}: pack_sources entry has no \`source:\``);
      continue;
    }
    const ref = item.get("ref");
    const path = item.get("path");
    const entry: PackSourceEntry = { source: source.trim(), label: where };
    if (typeof ref === "string" && ref) entry.ref = ref;
    if (typeof path === "string" && path) entry.path = path;
    entries.push(entry);
  }
  return entries;
}

function label(layer: Layer, node: Node | undefined): string {
  const offset = node?.range?.[0];
  if (offset === undefined) return layer.file;
  return `${layer.file}:${layer.lines.linePos(offset).line}`;
}

const FIELD_TYPES: readonly FieldType[] = ["string", "enum", "list", "date"];
const FIELD_KEYS = new Set([
  "type",
  "values",
  "mode",
  "closed",
  "required",
  "min_items",
  "max_items",
  "max_chars",
  "pattern",
  "kinds",
]);
const AUDIT_KEYS = new Set(["exclude", "ignore", "pack_dirs", "strict"]);

/** Collect one layer's `compound:` block; the schema builder merges declarations across layers. */
function readCompoundConfig(layer: Layer, out: CompoundConfig): void {
  const node = layer.doc.get("compound", true) as Node | undefined;
  if (node === undefined) return;
  const fail = (at: Node | undefined, message: string) => {
    out.errors.push(`${label(layer, at)}: ${message}`);
  };
  if (!isMap(node)) {
    fail(node, "`compound:` must be a mapping");
    return;
  }
  for (const pair of node.items) {
    const key = keyOf(pair.key);
    const value = pair.value as Node | undefined;
    if (key === "schema") readSchema(layer, value, out, fail);
    else if (key === "audit") readAudit(value, out, fail);
    else fail(value, `unknown \`compound.${key}:\` (this release reads \`schema\` and \`audit\`)`);
  }
}

type Fail = (at: Node | undefined, message: string) => void;

function readSchema(layer: Layer, node: Node | undefined, out: CompoundConfig, fail: Fail): void {
  if (!isMap(node)) {
    fail(node, "`compound.schema:` must be a mapping");
    return;
  }
  for (const pair of node.items) {
    const key = keyOf(pair.key);
    const value = pair.value as Node | undefined;
    if (key !== "fields") {
      fail(value, `\`compound.schema.${key}:\` is not read by this release (only \`fields\`)`);
      continue;
    }
    if (!isMap(value)) {
      fail(value, "`compound.schema.fields:` must be a mapping of field name to attributes");
      continue;
    }
    for (const field of value.items) {
      const name = keyOf(field.key);
      const override = readFieldOverride(name, field.value as Node | undefined, fail);
      if (override) {
        out.fields.push({
          name,
          layer: layer.file,
          label: label(layer, field.value as Node),
          override,
        });
      }
    }
  }
}

function readFieldOverride(
  name: string,
  node: Node | undefined,
  fail: Fail,
): FieldOverride | undefined {
  const at = `compound.schema.fields.${name}`;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    fail(node, `\`${at}\` is not a frontmatter key`);
    return undefined;
  }
  if (!isMap(node)) {
    fail(node, `\`${at}:\` must be a mapping of attributes (${[...FIELD_KEYS].join(", ")})`);
    return undefined;
  }
  const override: FieldOverride = {};
  let ok = true;
  const bad = (value: Node | undefined, message: string) => {
    fail(value, `\`${at}.${message}`);
    ok = false;
  };
  for (const pair of node.items) {
    const key = keyOf(pair.key);
    const value = pair.value as Node | undefined;
    if (!FIELD_KEYS.has(key)) {
      bad(value, `${key}\` is not an attribute (${[...FIELD_KEYS].join(", ")})`);
      continue;
    }
    switch (key) {
      case "type": {
        const text = scalarString(value);
        if (text && (FIELD_TYPES as readonly string[]).includes(text))
          override.type = text as FieldType;
        else bad(value, `type\` must be one of ${FIELD_TYPES.join(", ")}`);
        break;
      }
      case "values": {
        const list = value === undefined ? null : stringList(value);
        if (list?.length) override.values = list;
        else bad(value, "values` must be a non-empty list of strings");
        break;
      }
      case "mode": {
        const text = scalarString(value);
        if (text === "extend" || text === "replace") override.mode = text;
        else bad(value, "mode` must be extend or replace");
        break;
      }
      case "closed":
      case "required": {
        if (isScalar(value) && typeof value.value === "boolean") override[key] = value.value;
        else bad(value, `${key}\` must be true or false`);
        break;
      }
      case "min_items":
      case "max_items":
      case "max_chars": {
        if (isScalar(value) && Number.isInteger(value.value) && (value.value as number) >= 1) {
          const attribute =
            key === "min_items" ? "minItems" : key === "max_items" ? "maxItems" : "maxChars";
          override[attribute] = value.value as number;
        } else bad(value, `${key}\` must be a positive integer`);
        break;
      }
      case "pattern": {
        const text = scalarString(value);
        if (!text) {
          bad(value, "pattern` must be a string");
          break;
        }
        try {
          new RegExp(text);
          override.pattern = text;
        } catch {
          bad(value, "pattern` is not a valid regular expression");
        }
        break;
      }
      case "kinds": {
        const list = value === undefined ? null : stringList(value);
        if (list?.length && list.every((k) => (DOCUMENT_KINDS as readonly string[]).includes(k))) {
          override.kinds = list as DocumentKind[];
        } else bad(value, `kinds\` must list document kinds (${DOCUMENT_KINDS.join(", ")})`);
        break;
      }
      default:
        bad(value, `${key}\` is not an attribute`);
    }
  }
  if (ok && override.mode !== undefined && override.values === undefined) {
    bad(node, "mode` needs `values`");
  }
  return ok ? override : undefined;
}

function scalarString(node: Node | undefined): string | undefined {
  return isScalar(node) && typeof node.value === "string" && node.value.trim()
    ? node.value.trim()
    : undefined;
}

function readAudit(node: Node | undefined, out: CompoundConfig, fail: Fail): void {
  if (!isMap(node)) {
    fail(node, "`compound.audit:` must be a mapping");
    return;
  }
  for (const pair of node.items) {
    const key = keyOf(pair.key);
    const value = pair.value as Node | undefined;
    if (!AUDIT_KEYS.has(key)) {
      fail(
        value,
        `\`compound.audit.${key}:\` is not read by this release (${[...AUDIT_KEYS].join(", ")})`,
      );
    } else if (key === "strict") {
      if (isScalar(value) && typeof value.value === "boolean") out.audit.strict = value.value;
      else fail(value, "`compound.audit.strict` must be true or false");
    } else {
      const list = value === undefined ? null : stringList(value);
      if (list === null) {
        fail(value, `\`compound.audit.${key}:\` must be a list of strings`);
        continue;
      }
      const target =
        key === "pack_dirs"
          ? out.audit.packDirs
          : key === "exclude"
            ? out.audit.exclude
            : out.audit.ignore;
      target.push(...list.filter((v) => !target.includes(v)));
    }
  }
}

function keyOf(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key);
}

function stringList(node: Node): string[] | null {
  if (!isSeq(node)) return null;
  const out: string[] = [];
  for (const item of node.items) {
    if (!isScalar(item) || typeof item.value !== "string" || !item.value.trim()) return null;
    out.push(item.value.trim());
  }
  return out;
}
