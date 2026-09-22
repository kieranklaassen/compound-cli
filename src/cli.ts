import { type Context, processContext } from "./context.ts";
import { CliError } from "./errors.ts";
import { EXIT } from "./exit-codes.ts";
import { MAIN_HELP, VERSION } from "./help.ts";
import { errorMessage } from "./util.ts";

type CommandModule = { run: (argv: string[], ctx: Context) => Promise<number> };

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  find: () => import("./commands/find.ts"),
  packs: () => import("./commands/packs.ts"),
  bench: () => import("./commands/bench.ts"),
  doctor: () => import("./commands/doctor.ts"),
  audit: () => import("./commands/audit.ts"),
};

export async function main(argv: string[], ctx: Context = processContext()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    ctx.stdout(MAIN_HELP);
    return EXIT.OK;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    ctx.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  const loader = COMMANDS[command];
  if (loader === undefined) {
    ctx.stderr(`compound: unknown command "${command}" (run compound --help)\n`);
    return EXIT.USAGE;
  }
  const debug = rest.includes("--debug");
  const args = rest.filter((arg) => arg !== "--debug");
  try {
    const module = await loader();
    return await module.run(args, ctx);
  } catch (error) {
    if (error instanceof CliError) {
      ctx.stderr(`compound: ${error.message}\n`);
      if (debug && error.stack) ctx.stderr(`${error.stack}\n`);
      return error.exitCode;
    }
    ctx.stderr(`compound: internal error: ${errorMessage(error)}
`);
    if (debug && error instanceof Error && error.stack) ctx.stderr(`${error.stack}\n`);
    else ctx.stderr("compound: rerun with --debug for the stack trace\n");
    return EXIT.INTERNAL;
  }
}
