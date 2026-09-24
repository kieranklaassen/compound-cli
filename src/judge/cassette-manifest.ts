import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "../util.ts";
import type { CassetteMode } from "./api-key.ts";
import { writeFileAtomically } from "./cassette.ts";

/**
 * Recorded answers do not depend on the threshold, so a replay alone cannot
 * notice a threshold change; the manifest beside the cassettes pins what they
 * were scored at, and a gate refuses a disagreeing or missing pin.
 */
export type CassetteManifest = {
  recorded_at: string;
  threshold: number;
  tier_one_threshold: number;
  suggest_threshold?: number;
  model_requested: string;
  model_answered: string | null;
};

export function manifestPath(cassetteDir: string): string {
  return join(cassetteDir, "manifest.json");
}

export function readManifest(cassetteDir: string): CassetteManifest | Error | undefined {
  const path = manifestPath(cassetteDir);
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<CassetteManifest>;
    if (typeof manifest.threshold !== "number") return new Error("manifest.json has no threshold");
    return manifest as CassetteManifest;
  } catch (error) {
    return new Error(`manifest.json is unreadable: ${errorMessage(error)}`);
  }
}

export function writeManifest(cassetteDir: string, manifest: CassetteManifest): void {
  const path = manifestPath(cassetteDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomically(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Why a replay cannot be trusted at these thresholds, or undefined when it can. */
export function thresholdPinFailure(
  manifest: CassetteManifest | Error | undefined,
  mode: CassetteMode,
  threshold: number,
  suggestThreshold?: number,
): string | undefined {
  if (mode !== "replay" && mode !== "auto") return undefined;
  if (manifest === undefined) {
    return mode === "replay"
      ? "the cassettes have no manifest.json pinning the threshold they were recorded at"
      : undefined;
  }
  if (manifest instanceof Error) return `${manifest.message}; re-record the cassettes`;
  if (manifest.threshold !== threshold) {
    return `threshold ${threshold} differs from the recorded ${manifest.threshold}`;
  }
  if (
    suggestThreshold !== undefined &&
    manifest.suggest_threshold !== undefined &&
    manifest.suggest_threshold !== suggestThreshold
  ) {
    return `suggest threshold ${suggestThreshold} differs from the recorded ${manifest.suggest_threshold}`;
  }
  return undefined;
}
