import { HELP_OPTION, type OptionSpecs, parseCommandArgs, ROOT_OPTION } from "../args.ts";
import type { Context } from "../context.ts";
import { openWorkspace } from "../corpus/load.ts";
import { loadPackRules, publicResolution, resolvePacks } from "../corpus/packs.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { PACKS_HELP } from "../help.ts";

const LIST_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  json: { type: "boolean" },
} as const satisfies OptionSpecs;

export async function run(argv: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  switch (sub) {
    case "resolve":
      return runResolve(rest, ctx);
    case "list":
      return runList(rest, ctx);
    case "suggest":
      return (await import("./packs-suggest.ts")).runSuggest(rest, ctx);
    case "add":
      return (await import("./packs-add.ts")).runAdd(rest, ctx);
    default:
      throw new UsageError(`unknown packs subcommand "${sub}" (resolve, list, suggest, add)`);
  }
}

function runResolve(argv: string[], ctx: Context): number {
  const parsed = parseCommandArgs(argv, LIST_OPTIONS);
  if (parsed.values.help) {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  const workspace = openWorkspace(ctx.cwd, ctx.env, parsed.values.root);
  const resolution = resolvePacks(workspace.config, workspace.git);
  ctx.stdout(`${JSON.stringify(publicResolution(resolution))}\n`);
  return EXIT.OK;
}

function runList(argv: string[], ctx: Context): number {
  const parsed = parseCommandArgs(argv, LIST_OPTIONS);
  if (parsed.values.help) {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  const workspace = openWorkspace(ctx.cwd, ctx.env, parsed.values.root);
  const resolution = resolvePacks(workspace.config, workspace.git);
  const rules = loadPackRules(resolution.roots);
  const packs = resolution.roots.map((root) => ({
    id: root.id,
    dir: root.dir,
    url: root.url,
    ref: root.ref,
    rules: rules.candidates
      .filter((c) => c.packId === root.id)
      .map((c) => ({ path: c.packPath, title: c.title, applies_when: c.appliesWhen })),
  }));
  const warnings = [...resolution.warnings, ...rules.warnings];
  if (parsed.values.json) {
    ctx.stdout(`${JSON.stringify({ packs, warnings, errors: resolution.errors }, null, 2)}\n`);
    return EXIT.OK;
  }
  if (packs.length === 0) ctx.stdout("No packs declared.\n");
  for (const pack of packs) {
    const origin = pack.url ? `${pack.url}@${pack.ref}` : pack.dir;
    ctx.stdout(`${pack.id}  (${pack.rules.length} rules)  ${origin}\n`);
    for (const rule of pack.rules) {
      ctx.stdout(`  ${rule.path}  ${rule.title}\n`);
      for (const when of rule.applies_when) ctx.stdout(`      when: ${when}\n`);
    }
  }
  for (const warning of warnings) ctx.stderr(`warning: ${warning}\n`);
  for (const error of resolution.errors) ctx.stderr(`error: ${error}\n`);
  return EXIT.OK;
}
