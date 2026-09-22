import type { Context } from "../context.ts";
import { openWorkspace } from "../corpus/load.ts";
import { knownSourcePackCandidates } from "../corpus/pack-sources.ts";
import { EXIT } from "../exit-codes.ts";
import { runFind } from "../find/find.ts";
import { FIND_HELP } from "../help.ts";
import { buildWorkState } from "../input/work-state.ts";
import { judgeFromEnv } from "../judge/client.ts";
import { emit } from "../output/render.ts";
import { parseFindOptions } from "./find-options.ts";

export async function run(argv: string[], ctx: Context): Promise<number> {
  const options = parseFindOptions(argv);
  if (options.help) {
    ctx.stdout(FIND_HELP);
    return EXIT.OK;
  }
  // Order matters: usage errors first (argument parsing), then the key check,
  // then anything that reads the corpus or the network (plan R28).
  const state = await buildWorkState(options.input, ctx);
  const judge = judgeFromEnv(ctx.env, {
    model: options.judge.model,
    parallel: options.judge.parallel,
  });
  const workspace = openWorkspace(ctx.cwd, ctx.env, options.root);
  const run = await runFind({
    workspace,
    state,
    judge,
    settings: options.judge,
    filters: options.filters,
    mode: options.mode,
    ...(options.consultSources ? { loadPackCandidates: knownSourcePackCandidates } : {}),
  });
  emit(run.result, options.output, ctx);
  return EXIT.OK;
}
