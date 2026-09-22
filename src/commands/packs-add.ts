import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { HELP_OPTION, type OptionSpecs, parseCommandArgs, ROOT_OPTION } from "../args.ts";
import { CONFIG_DIR, loadCeConfig } from "../config/ce-config.ts";
import type { Context } from "../context.ts";
import { openWorkspace } from "../corpus/load.ts";
import { loadPackCandidates } from "../corpus/pack-sources.ts";
import { resolvePacks } from "../corpus/packs.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { PACKS_HELP } from "../help.ts";

const ADD_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  yes: { type: "boolean", short: "y" },
} as const satisfies OptionSpecs;

export async function runAdd(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, ADD_OPTIONS);
  if (parsed.values.help) {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1)
    throw new UsageError("packs add takes exactly one pack id");
  const workspace = openWorkspace(ctx.cwd, ctx.env, parsed.values.root);
  const resolution = resolvePacks(workspace.config, workspace.git);
  const declared = new Set(resolution.roots.map((r) => r.id));
  if (declared.has(id)) {
    ctx.stdout(`pack ${id} is already declared; nothing written\n`);
    return EXIT.OK;
  }
  const load = loadPackCandidates(workspace.config, declared, ctx.env);
  const candidate = load.candidates.find((c) => c.packId === id);
  if (!candidate?.declaration) {
    const known =
      load.candidates
        .map((c) => c.packId)
        .filter(Boolean)
        .sort()
        .join(", ") || "none";
    throw new UsageError(`no known source publishes an undeclared pack "${id}" (known: ${known})`);
  }
  const entry = renderEntry(candidate.declaration);
  const configPath = join(workspace.repoRoot, CONFIG_DIR, "config.yaml");
  ctx.stdout(`Will append to ${configPath}:\n\npacks:\n${entry}\n`);
  if (!parsed.values.yes) {
    if (!ctx.isTTY) throw new UsageError("pass --yes to write without confirmation");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Append this entry? [y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      ctx.stdout("nothing written\n");
      return EXIT.OK;
    }
  }
  const written = appendPackEntry(configPath, entry);
  ctx.stdout(
    written ? `wrote ${configPath}\n` : `entry already present in ${configPath}; nothing written\n`,
  );
  return EXIT.OK;
}

/** Render the declaration as list-item YAML lines, `source` first. */
export function renderEntry(declaration: Record<string, string>, indent = "  "): string {
  return Object.entries(declaration)
    .map(
      ([key, value], index) => `${indent}${index === 0 ? "- " : "  "}${key}: ${yamlScalar(value)}`,
    )
    .join("\n");
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_./~:@-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Append one `packs:` entry and nothing else. An existing `packs:` block list
 * gets the entry after its last item; otherwise a `packs:` key is appended at
 * the end of the file. The file is created when absent. Returns false when the
 * same entry is already present.
 */
export function appendPackEntry(configPath: string, entry: string): boolean {
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  if (existing.includes(entry.trim())) return false;
  const lines = existing === "" ? [] : existing.split(/\r?\n/);
  const packsIndex = lines.findIndex((line) => /^packs:\s*(#.*)?$/.test(line));
  let output: string[];
  if (packsIndex === -1) {
    output = [...trimTrailingBlank(lines)];
    if (output.length) output.push("");
    output.push("packs:", ...entry.split("\n"));
  } else {
    let end = packsIndex + 1;
    let itemIndent: string | undefined;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (line.trim() === "" || line.trim().startsWith("#")) {
        end++;
        continue;
      }
      const isItem = /^\s*-\s/.test(line);
      const indented = /^\s+/.test(line);
      if (!isItem && !indented) break;
      if (isItem && itemIndent === undefined) itemIndent = line.match(/^\s*/)?.[0] ?? "";
      end++;
    }
    // Back up over trailing blank lines so the entry sits with its siblings.
    while (end > packsIndex + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    const rendered = itemIndent === undefined ? entry : entry.replace(/^ {2}/gm, itemIndent);
    output = [...lines.slice(0, end), ...rendered.split("\n"), ...lines.slice(end)];
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const text = output.join("\n");
  writeFileSync(configPath, text.endsWith("\n") ? text : `${text}\n`);
  // Confirm the result still parses as a packs list.
  loadCeConfig(dirname(dirname(configPath)));
  return true;
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
}
