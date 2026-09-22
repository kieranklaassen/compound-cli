import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from "yaml";
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

export type CeConfig = {
  repoRoot: string;
  /** Repo-relative artifact root, `docs` by default. */
  docsRoot: string;
  docsRootAbs: string;
  docsRootSource: ConfigFile | "default";
  packs: PackEntry[];
  packSources: PackSourceEntry[];
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
  for (const layer of layers) {
    packs.push(...readPackEntries(layer, errors));
    packSources.push(...readPackSources(layer, errors));
  }
  return {
    repoRoot,
    docsRoot,
    docsRootAbs,
    docsRootSource: docsRootPick?.file ?? "default",
    packs,
    packSources,
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
