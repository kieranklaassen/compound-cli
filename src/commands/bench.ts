import type { Context } from "../context.ts";
import { EXIT } from "../exit-codes.ts";
import { BENCH_HELP } from "../help.ts";

export async function run(argv: string[], ctx: Context): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.stdout(BENCH_HELP);
    return EXIT.OK;
  }
  throw new Error("bench is not implemented yet");
}
