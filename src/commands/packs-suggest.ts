import { HELP_OPTION, type OptionSpecs, parseCommandArgs, ROOT_OPTION } from "../args.ts";
import type { Context } from "../context.ts";
import type { Candidate } from "../corpus/candidate.ts";
import { openWorkspace } from "../corpus/load.ts";
import { type FetchPolicy, loadPackCandidates } from "../corpus/pack-sources.ts";
import { resolvePacks } from "../corpus/packs.ts";
import { EXIT } from "../exit-codes.ts";
import { SCHEMA_VERSION } from "../find/result.ts";
import { judgePackCandidates } from "../find/tier-one.ts";
import { PACKS_HELP } from "../help.ts";
import { repoProfile } from "../input/repo-profile.ts";
import { buildWorkState, hasAnyChannel, judgeState } from "../input/work-state.ts";
import { judgeFromEnv } from "../judge/client.ts";
import { publicState } from "../output/json.ts";
import { declarationLines, round4 } from "../util.ts";
import { CHANNEL_OPTIONS, channelInput, resolveJudgeSettings } from "./find-options.ts";

export const SUGGEST_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  json: { type: "boolean" },
  refresh: { type: "boolean" },
  ...CHANNEL_OPTIONS,
  threshold: { type: "string" },
  batch: { type: "string" },
  parallel: { type: "string" },
  model: { type: "string" },
} as const satisfies OptionSpecs;

export type Suggestion = {
  pack_id: string;
  title: string;
  applies_when: string[];
  score: number;
  declaration: Record<string, string>;
};

export async function runSuggest(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, SUGGEST_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  const { threshold, batch, parallel, model } = resolveJudgeSettings(v);
  const input = channelInput(parsed);
  const state = hasAnyChannel(input) ? await buildWorkState(input, ctx) : null;
  const judge = judgeFromEnv(ctx.env, { model, parallel });
  const workspace = openWorkspace(ctx.cwd, ctx.env, v.root);
  const resolution = resolvePacks(workspace.config, workspace.git);
  const declared = new Set(resolution.roots.map((r) => r.id));
  const policy: FetchPolicy = v.refresh ? "refresh" : "cached-or-clone";
  const load = loadPackCandidates(workspace.config, declared, ctx.env, policy);
  const warnings = [...resolution.warnings, ...load.warnings];

  const work = state
    ? judgeState(state)
    : { repository: repoProfile(workspace.repoRoot, [...declared]) };
  const scores = await judgePackCandidates(judge, work, load.candidates, batch);
  const suggestions = load.candidates
    .map((candidate) => toSuggestion(candidate, scores.get(candidate) ?? 0))
    .sort((a, b) => b.score - a.score || a.pack_id.localeCompare(b.pack_id));
  const above = suggestions.filter((s) => s.score >= threshold);

  if (v.json) {
    ctx.stdout(
      `${JSON.stringify(
        {
          schema_version: SCHEMA_VERSION,
          mode: "suggest",
          state: state ? publicState(state) : null,
          repository: state ? null : work.repository,
          suggestions: above,
          considered: suggestions.map(({ pack_id, score }) => ({ pack_id, score })),
          declared: [...declared],
          threshold,
          usage: judge.usage.snapshot(),
          warnings,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }
  if (load.candidates.length === 0) {
    ctx.stdout("No undeclared packs found in the known sources.\n");
  } else if (above.length === 0) {
    ctx.stdout(`No pack met the threshold ${threshold}; ${suggestions.length} considered.\n`);
  }
  for (const s of above) {
    ctx.stdout(`${s.score.toFixed(2)}  ${s.pack_id}  ${s.title}\n`);
    for (const when of s.applies_when) ctx.stdout(`      when: ${when}\n`);
    ctx.stdout("      declare with:\n        packs:\n");
    for (const line of declarationLines(s.declaration, "          ")) ctx.stdout(`${line}\n`);
    ctx.stdout(`      or run: compound packs add ${s.pack_id}\n\n`);
  }
  const u = judge.usage.snapshot();
  ctx.stdout(
    `usage: ${u.requests} requests, ${u.input_tokens} input tokens, $${u.estimated_usd.toFixed(5)}, ${u.wall_ms} ms\n`,
  );
  for (const warning of warnings) ctx.stderr(`warning: ${warning}\n`);
  return EXIT.OK;
}

function toSuggestion(candidate: Candidate, score: number): Suggestion {
  return {
    pack_id: candidate.packId ?? candidate.path,
    title: candidate.title,
    applies_when: candidate.appliesWhen,
    score: round4(score),
    declaration: candidate.declaration ?? {},
  };
}
