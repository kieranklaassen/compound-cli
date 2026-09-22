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
import type { ChannelInput } from "../input/work-state.ts";

export const FIND_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  ...OUTPUT_OPTIONS,
  concept: { type: "string", multiple: true },
  decision: { type: "string", multiple: true },
  domain: { type: "string", multiple: true },
  module: { type: "string", multiple: true },
  path: { type: "string", multiple: true },
  diff: { type: "string" },
  plan: { type: "string" },
  doc: { type: "string" },
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
  debug: { type: "boolean" },
} as const satisfies OptionSpecs;

export type FindMode = "find" | "gate" | "overlap";
export type OutputFormat = "json" | "compact" | "report";

export type JudgeSettings = {
  threshold: number;
  tierOneThreshold: number;
  frontmatterOnly: boolean;
  batch: number;
  parallel: number;
  candidateCap: number;
  excerptChars: number;
  model: string;
};

export type CandidateFilters = {
  kinds: CandidateKind[];
  problemTypes: string[];
  modules: string[];
  tags: string[];
  packs: string[];
};

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
    input: {
      activity: parsed.positionals[0],
      concepts: v.concept ?? [],
      decisions: v.decision ?? [],
      domains: v.domain ?? [],
      modules: v.module ?? [],
      paths: v.path ?? [],
      diffPath: v.diff,
      planPath: v.plan,
      docPath: v.doc,
    },
    judge: {
      threshold: requireProbability("threshold", v.threshold, DEFAULTS.threshold),
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
    },
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
