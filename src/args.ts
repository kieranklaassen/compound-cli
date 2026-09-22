import { type ParseArgsConfig, parseArgs } from "node:util";
import { UsageError } from "./errors.ts";
import { errorMessage } from "./util.ts";

type OptionSpec = {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[];
};

export type OptionSpecs = Record<string, OptionSpec>;

export type Parsed<S extends OptionSpecs> = {
  values: {
    [K in keyof S]: S[K]["type"] extends "boolean"
      ? boolean | undefined
      : S[K]["multiple"] extends true
        ? string[] | undefined
        : string | undefined;
  };
  positionals: string[];
};

export function parseCommandArgs<S extends OptionSpecs>(argv: string[], specs: S): Parsed<S> {
  type Descriptor = NonNullable<ParseArgsConfig["options"]>[string];
  const options: Record<string, Descriptor> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const entry: Descriptor = { type: spec.type };
    if (spec.short !== undefined) entry.short = spec.short;
    if (spec.multiple) entry.multiple = true;
    if (spec.default !== undefined) entry.default = spec.default;
    options[name] = entry;
  }
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: parsed.values as Parsed<S>["values"], positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(usageMessage(error));
  }
}

function usageMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/^.*?: /, "")
    .replace(/\. To specify.*$/s, "")
    .replace(/\.$/, "");
}

export function requireNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${name} must be a number (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function requireInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = requireNumber(name, raw, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function requireProbability(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const value = requireNumber(name, raw, fallback);
  if (value < 0 || value > 1) {
    throw new UsageError(`--${name} must be between 0 and 1 (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export const ROOT_OPTION = {
  root: { type: "string" },
} as const satisfies OptionSpecs;

export const OUTPUT_OPTIONS = {
  json: { type: "boolean" },
  compact: { type: "boolean" },
} as const satisfies OptionSpecs;

export const HELP_OPTION = {
  help: { type: "boolean", short: "h" },
} as const satisfies OptionSpecs;
