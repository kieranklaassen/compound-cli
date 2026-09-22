import {
  HELP_OPTION,
  type OptionSpecs,
  OUTPUT_OPTIONS,
  type Parsed,
  parseCommandArgs,
  ROOT_OPTION,
  requireInteger,
  requireProbability,
} from "../args.ts";
import type { CandidateKind } from "../corpus/candidate.ts";
import { UsageError } from "../errors.ts";
import { DEFAULTS } from "../find/defaults.ts";
import type { CandidateFilters } from "../find/filters.ts";
import type { JudgeSettings } from "../find/find.ts";
import type { FindMode } from "../find/result.ts";
import type { ChannelInput } from "../input/work-state.ts";
import type { OutputFormat } from "../output/render.ts";

export const CHANNEL_OPTIONS = {
  concept: { type: "string", multiple: true },
  decision: { type: "string", multiple: true },
  domain: { type: "string", multiple: true },
  module: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  diff: { type: "string" },
  plan: { type: "string" },
  doc: { type: "string" },
} as const satisfies OptionSpecs;

export const FIND_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  ...OUTPUT_OPTIONS,
  ...CHANNEL_OPTIONS,
  gate: { type: "boolean" },
  overlap: { type: "boolean" },
  threshold: { type: "string" },
  "tier-one-threshold": { type: "string" },
  "frontmatter-only": { type: "boolean" },
  batch: { type: "string" },
  parallel: { type: "string" },
  "candidate-cap": { type: "string" },
  "excerpt-chars": { type: "string" },
  model: { type: "string" },
  kind: { type: "string", multiple: true },
  "problem-type": { type: "string", multiple: true },
  "module-filter": { type: "string", multiple: true },
  tag: { type: "string", multiple: true },
  pack: { type: "string", multiple: true },
  "no-sources": { type: "boolean" },
} as const satisfies OptionSpecs;

export type FindOptions = {
  help: boolean;
  root: string | undefined;
  output: OutputFormat;
  mode: FindMode;
  input: ChannelInput;
  judge: JudgeSettings;
  filters: CandidateFilters;
  consultSources: boolean;
};

const KINDS: readonly CandidateKind[] = ["solution", "pack_rule", "pack_candidate"];

export function parseFindOptions(argv: string[]): FindOptions {
  const parsed = parseCommandArgs(argv, FIND_OPTIONS);
  return resolveFindOptions(parsed);
}

export function resolveFindOptions(parsed: Parsed<typeof FIND_OPTIONS>): FindOptions {
  const v = parsed.values;
  if (parsed.positionals.length > 1) {
    throw new UsageError(
      `expected one activity sentence, got ${parsed.positionals.length} positional arguments (quote the sentence)`,
    );
  }
  if (v.json && v.compact) throw new UsageError("--json and --compact are mutually exclusive");
  if (v.gate && v.overlap) throw new UsageError("--gate and --overlap are mutually exclusive");
  if (v.overlap && v.doc === undefined) throw new UsageError("--overlap requires --doc <draft>");

  const kinds = (v.kind ?? []).map((raw) => {
    if ((KINDS as readonly string[]).includes(raw)) return raw as CandidateKind;
    throw new UsageError(`--kind must be one of ${KINDS.join(", ")} (got ${JSON.stringify(raw)})`);
  });

  return {
    help: Boolean(v.help),
    root: v.root,
    output: v.json ? "json" : v.compact ? "compact" : "report",
    mode: v.gate ? "gate" : v.overlap ? "overlap" : "find",
    input: channelInput(parsed),
    judge: resolveJudgeSettings(v),
    filters: {
      kinds,
      problemTypes: v["problem-type"] ?? [],
      modules: v["module-filter"] ?? [],
      tags: v.tag ?? [],
      packs: v.pack ?? [],
    },
    consultSources: !v["no-sources"],
  };
}

/** The judge flags every judging command shares; a spec may omit some and take the default. */
export type JudgeFlagValues = {
  threshold?: string | undefined;
  "tier-one-threshold"?: string | undefined;
  "frontmatter-only"?: boolean | undefined;
  batch?: string | undefined;
  parallel?: string | undefined;
  "candidate-cap"?: string | undefined;
  "excerpt-chars"?: string | undefined;
  model?: string | undefined;
};

export function resolveJudgeSettings(v: JudgeFlagValues): JudgeSettings {
  return {
    // --frontmatter-only scores are tier-one probabilities, the scale pack suggestions use.
    threshold: requireProbability(
      "threshold",
      v.threshold,
      v["frontmatter-only"] ? DEFAULTS.suggestThreshold : DEFAULTS.threshold,
    ),
    tierOneThreshold: requireProbability(
      "tier-one-threshold",
      v["tier-one-threshold"],
      DEFAULTS.tierOneThreshold,
    ),
    frontmatterOnly: Boolean(v["frontmatter-only"]),
    batch: requireInteger("batch", v.batch, DEFAULTS.batch),
    parallel: requireInteger("parallel", v.parallel, DEFAULTS.parallel),
    candidateCap: requireInteger("candidate-cap", v["candidate-cap"], DEFAULTS.candidateCap),
    excerptChars: requireInteger("excerpt-chars", v["excerpt-chars"], DEFAULTS.excerptChars),
    model: v.model ?? DEFAULTS.model,
  };
}

/** The input channels from a parsed command line: the first positional plus the channel flags. */
export function channelInput(parsed: Parsed<typeof CHANNEL_OPTIONS>): ChannelInput {
  const v = parsed.values;
  return {
    activity: parsed.positionals[0],
    concepts: v.concept ?? [],
    decisions: v.decision ?? [],
    domains: v.domain ?? [],
    modules: v.module ?? [],
    paths: v.path ?? [],
    diffPath: v.diff,
    planPath: v.plan,
    docPath: v.doc,
  };
}
