import type { Context } from "../context.ts";
import { EXIT } from "../exit-codes.ts";
import { DOCTOR_HELP } from "../help.ts";

export async function run(argv: string[], ctx: Context): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    ctx.stdout(DOCTOR_HELP);
    return EXIT.OK;
  }
  throw new Error("doctor is not implemented yet");
}
