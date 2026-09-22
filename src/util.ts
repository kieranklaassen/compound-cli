import { homedir } from "node:os";
import type { Env } from "./context.ts";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function homeDir(env: Env): string {
  return env.HOME ?? homedir();
}

/** YAML list-item lines for a declaration, `source` first; the first key gets the dash. */
export function declarationLines(declaration: Record<string, string>, indent: string): string[] {
  return Object.entries(declaration).map(
    ([key, value], index) => `${indent}${index === 0 ? "- " : "  "}${key}: ${value}`,
  );
}
