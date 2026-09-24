import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  HELP_OPTION,
  type OptionSpecs,
  parseCommandArgs,
  ROOT_OPTION,
  requireInteger,
  requireNumber,
  requireProbability,
} from "../args.ts";
import { loadCeConfig } from "../config/ce-config.ts";
import { resolveRepoRoot } from "../config/repo-root.ts";
import type { Context } from "../context.ts";
import { UsageError } from "../errors.ts";
import { writeMissCase } from "../eval/add.ts";
import { importJsonSuite } from "../eval/import.ts";
import { renderEval } from "../eval/report.ts";
import { type EvalMode, runEval } from "../eval/run.ts";
import { type Channel, loadCases } from "../eval/suite.ts";
import { EXIT } from "../exit-codes.ts";
import { DEFAULTS } from "../find/defaults.ts";
import { EVAL_HELP } from "../help.ts";
import { resolveJudgeSettings } from "./find-options.ts";

const EVAL_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  case: { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  kind: { type: "string", multiple: true },
  replay: { type: "boolean" },
  record: { type: "boolean" },
  live: { type: "boolean" },
  sweep: { type: "string" },
  "enforce-floor": { type: "boolean" },
  "max-cost-usd": { type: "string" },
  json: { type: "boolean" },
  out: { type: "string" },
  threshold: { type: "string" },
  "suggest-threshold": { type: "string" },
  "tier-one-threshold": { type: "string" },
  "frontmatter-only": { type: "boolean" },
  batch: { type: "string" },
  parallel: { type: "string" },
  "excerpt-chars": { type: "string" },
  "candidate-cap": { type: "string" },
  model: { type: "string" },
  jobs: { type: "string" },
} as const satisfies OptionSpecs;

const IMPORT_OPTIONS = {
  ...HELP_OPTION,
  out: { type: "string" },
  cassettes: { type: "string" },
  "cassettes-out": { type: "string" },
  "plans-from": { type: "string" },
  "plans-to": { type: "string" },
  tag: { type: "string", multiple: true },
  "corpus-git": { type: "string" },
  "corpus-ref": { type: "string" },
  "corpus-path": { type: "string" },
  "docs-root": { type: "string" },
  packs: { type: "boolean" },
  threshold: { type: "string" },
  "suggest-threshold": { type: "string" },
} as const satisfies OptionSpecs;

const ADD_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  miss: { type: "boolean" },
  out: { type: "string" },
  id: { type: "string" },
  expect: { type: "string", multiple: true },
  "expect-pack": { type: "string", multiple: true },
  "near-miss": { type: "string", multiple: true },
  note: { type: "string" },
  tag: { type: "string", multiple: true },
  plan: { type: "string" },
  "redact-citations": { type: "boolean" },
  concept: { type: "string", multiple: true },
  decision: { type: "string", multiple: true },
  domain: { type: "string", multiple: true },
  module: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  "corpus-git": { type: "string" },
  "corpus-ref": { type: "string" },
} as const satisfies OptionSpecs;

export async function run(argv: string[], ctx: Context): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "import") return runImport(rest, ctx);
  if (sub === "add") return runAdd(rest, ctx);
  return runCases(argv, ctx);
}

async function runCases(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, EVAL_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(EVAL_HELP);
    return EXIT.OK;
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`eval takes one path (got ${parsed.positionals.join(" ")})`);
  }
  const modes = [v.replay && "replay", v.record && "record", v.live && "live"].filter(Boolean);
  if (modes.length > 1) throw new UsageError("--replay, --record, and --live exclude one another");
  const mode = (modes[0] as EvalMode | undefined) ?? null;
  const root = resolve(ctx.cwd, parsed.positionals[0] ?? "evals");
  const settings = resolveJudgeSettings(v);
  const sweep = (v.sweep ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => requireProbability("sweep", s, 0));
  const maxCost =
    v["max-cost-usd"] === undefined ? null : requireNumber("max-cost-usd", v["max-cost-usd"], 0);
  if (maxCost !== null && maxCost <= 0) throw new UsageError("--max-cost-usd must be above 0");
  const kinds = new Set<string>(v.kind ?? []);
  for (const kind of kinds) {
    if (!["find", "packs", "suggest", "audit"].includes(kind)) {
      throw new UsageError(`--kind ${kind}: find, packs, or audit`);
    }
  }
  if (kinds.has("audit")) {
    throw new UsageError("--kind audit: audit agreement suites are not in this release");
  }

  const { cases: all, suites } = loadCases(root);
  const wantedIds = new Set(v.case ?? []);
  const wantedTags = new Set(v.tag ?? []);
  const wantedChannels = new Set<Channel>(
    [...kinds].map((k) => (k === "packs" || k === "suggest" ? "suggest" : "find")),
  );
  // --kind selects cases that have the channel and runs only that channel on them.
  const cases = all
    .filter(
      (c) =>
        (!wantedIds.size || wantedIds.has(c.id) || wantedIds.has(c.id.split("/").pop() ?? "")) &&
        (!wantedTags.size || c.tags.some((t) => wantedTags.has(t))) &&
        (!wantedChannels.size || c.channels.some((ch) => wantedChannels.has(ch))),
    )
    .map((c) =>
      wantedChannels.size
        ? { ...c, channels: c.channels.filter((ch) => wantedChannels.has(ch)) }
        : c,
    );
  if (!cases.length) {
    throw new UsageError(
      all.length
        ? "no cases match the filters"
        : `${root}: no cases found (a case is a directory with query.md and expect.yaml)`,
    );
  }
  // A suite may set its own bars; flags override them for the whole run.
  const suiteThreshold = cases.find((c) => c.suite.threshold !== null)?.suite.threshold ?? null;
  const suiteSuggest =
    cases.find((c) => c.suite.suggest_threshold !== null)?.suite.suggest_threshold ?? null;
  if (v.threshold === undefined && suiteThreshold !== null) settings.threshold = suiteThreshold;
  const suggestThreshold =
    v["suggest-threshold"] !== undefined
      ? requireProbability("suggest-threshold", v["suggest-threshold"], DEFAULTS.suggestThreshold)
      : (suiteSuggest ?? DEFAULTS.suggestThreshold);

  const report = await runEval(
    root,
    cases,
    suites,
    {
      settings,
      suggestThreshold,
      mode,
      sweep,
      jobs: requireInteger("jobs", v.jobs, 1),
      maxCostUsd: maxCost,
      rootOverride: v.root,
      ...(v.json ? {} : { onProgress: (line: string) => ctx.stderr(`${line}\n`) }),
    },
    ctx,
  );
  if (v.out) {
    const outPath = resolve(ctx.cwd, v.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (v.json) ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else ctx.stdout(renderEval(report));
  if (v["enforce-floor"] && report.floor_failures.length) {
    for (const failure of report.floor_failures) ctx.stderr(`compound eval: ${failure}\n`);
    return EXIT.FINDINGS;
  }
  return EXIT.OK;
}

function runImport(argv: string[], ctx: Context): number {
  const parsed = parseCommandArgs(argv, IMPORT_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(EVAL_HELP);
    return EXIT.OK;
  }
  const [jsonPath] = parsed.positionals;
  if (!jsonPath) throw new UsageError("eval import needs a cases JSON file");
  if (!v.out) throw new UsageError("eval import needs --out <cases directory>");
  if ((v["plans-from"] === undefined) !== (v["plans-to"] === undefined)) {
    throw new UsageError("--plans-from and --plans-to go together");
  }
  const corpus: Record<string, string> = {};
  if (v["corpus-git"]) corpus.git = v["corpus-git"];
  if (v["corpus-ref"]) corpus.ref = v["corpus-ref"];
  if (v["corpus-path"]) corpus.path = v["corpus-path"];
  if (v["docs-root"]) corpus.docs_root = v["docs-root"];
  const result = importJsonSuite(resolve(ctx.cwd, jsonPath), {
    out: resolve(ctx.cwd, v.out),
    ...(v.cassettes ? { cassettes: resolve(ctx.cwd, v.cassettes) } : {}),
    ...(v["cassettes-out"] ? { cassettesOut: resolve(ctx.cwd, v["cassettes-out"]) } : {}),
    ...(v["plans-from"] ? { plansFrom: v["plans-from"] } : {}),
    ...(v["plans-to"] ? { plansTo: v["plans-to"] } : {}),
    ...(v.tag?.length ? { tags: v.tag } : {}),
    ...(Object.keys(corpus).length ? { corpus } : {}),
    ...(v.packs ? { packs: true } : {}),
    ...(v.threshold !== undefined
      ? { threshold: requireProbability("threshold", v.threshold, 0) }
      : {}),
    ...(v["suggest-threshold"] !== undefined
      ? { suggestThreshold: requireProbability("suggest-threshold", v["suggest-threshold"], 0) }
      : {}),
  });
  ctx.stdout(
    `imported ${result.cases} cases into ${v.out}${result.cassettes ? `, ${result.cassettes} cassettes` : ""}; suite at ${result.suite}\n`,
  );
  for (const line of result.skipped) ctx.stderr(`skipped: ${line}\n`);
  return EXIT.OK;
}

function runAdd(argv: string[], ctx: Context): number {
  const parsed = parseCommandArgs(argv, ADD_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(EVAL_HELP);
    return EXIT.OK;
  }
  if (!v.miss)
    throw new UsageError("eval add: only --miss is supported (harvest a real miss as a case)");
  if (!v.out) throw new UsageError("eval add --miss needs --out <cases directory>");
  if (!v.id) throw new UsageError("eval add --miss needs --id <slug>");
  const repo = resolveRepoRoot(ctx.cwd, v.root);
  const config = loadCeConfig(repo.root);
  const activity = parsed.positionals.join(" ").trim();
  const written = writeMissCase(
    {
      id: v.id,
      ...(activity ? { activity } : {}),
      concepts: v.concept ?? [],
      decisions: v.decision ?? [],
      domains: v.domain ?? [],
      modules: v.module ?? [],
      paths: v.path ?? [],
      ...(v.plan ? { plan: v.plan } : {}),
      redactCitations: Boolean(v["redact-citations"]),
      hits: v.expect ?? [],
      packs: v["expect-pack"] ?? [],
      nearMiss: v["near-miss"] ?? [],
      note: v.note ?? "",
      tags: v.tag ?? [],
      repoRoot: repo.root,
      docsRoot: config.docsRoot,
      ...(v["corpus-git"] ? { corpusGit: v["corpus-git"] } : {}),
      ...(v["corpus-ref"] ? { corpusRef: v["corpus-ref"] } : {}),
    },
    resolve(ctx.cwd, v.out),
  );
  ctx.stdout(
    `wrote ${written.dir} pinned to ${written.corpus.git}@${written.corpus.ref.slice(0, 7)}\n`,
  );
  return EXIT.OK;
}
