import type { Context } from "../context.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { FIND_HELP } from "../help.ts";
import { requireApiKey } from "../judge/api-key.ts";
import { CHANNEL_HINT, hasAnyChannel, parseFindOptions } from "./find-options.ts";

export async function run(argv: string[], ctx: Context): Promise<number> {
  const options = parseFindOptions(argv);
  if (options.help) {
    ctx.stdout(FIND_HELP);
    return EXIT.OK;
  }
  if (!hasAnyChannel(options.input)) throw new UsageError(CHANNEL_HINT);
  requireApiKey(ctx.env);
  throw new Error("find is not implemented yet");
}
