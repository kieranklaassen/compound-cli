import type { Env } from "../context.ts";
import { NotConfiguredError } from "../errors.ts";

export const API_KEY_VARIABLE = "TYPESAFE_API_KEY";
export const CASSETTE_MODE_VARIABLE = "COMPOUND_CASSETTE_MODE";
export const CASSETTE_DIR_VARIABLE = "COMPOUND_CASSETTE_DIR";

export type CassetteMode = "off" | "record" | "replay";

export function cassetteMode(env: Env): CassetteMode {
  const raw = env[CASSETTE_MODE_VARIABLE]?.trim().toLowerCase();
  if (raw === "record" || raw === "replay") return raw;
  return "off";
}

export function hasApiKey(env: Env): boolean {
  return Boolean(env[API_KEY_VARIABLE]?.trim());
}

/**
 * Resolve the judge key before any corpus read or network call. Replay mode
 * never talks to the network, so it runs with a placeholder key and CI needs
 * no secret.
 */
export function requireApiKey(env: Env): string {
  const key = env[API_KEY_VARIABLE]?.trim();
  if (key) return key;
  if (cassetteMode(env) === "replay") return "replay-placeholder";
  throw new NotConfiguredError(API_KEY_VARIABLE);
}
