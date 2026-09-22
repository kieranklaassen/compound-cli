import type { Context } from "../context.ts";
import type { FindResult } from "../find/result.ts";
import { renderCompact } from "./compact.ts";
import { renderJson } from "./json.ts";
import { renderReport } from "./report.ts";

export type OutputFormat = "json" | "compact" | "report";

/** Write a result in the chosen format; warnings go to stderr unless the format carries them. */
export function emit(result: FindResult, format: OutputFormat, ctx: Context): void {
  switch (format) {
    case "json":
      ctx.stdout(renderJson(result));
      return;
    case "compact":
      ctx.stdout(renderCompact(result));
      for (const warning of result.warnings) ctx.stderr(`warning: ${warning}\n`);
      return;
    case "report":
      ctx.stdout(renderReport(result));
      return;
    default: {
      const exhaustive: never = format;
      throw new Error(`unknown output format ${String(exhaustive)}`);
    }
  }
}
