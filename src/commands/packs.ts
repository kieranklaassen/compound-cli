import type { Context } from "../context.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { PACKS_HELP } from "../help.ts";

export async function run(argv: string[], ctx: Context): Promise<number> {
  const [sub] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    ctx.stdout(PACKS_HELP);
    return EXIT.OK;
  }
  throw new UsageError(`unknown packs subcommand "${sub}" (resolve, list, suggest, add)`);
}
