import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JudgeSettings } from "../find/find.ts";
import { errorMessage } from "../util.ts";
import type { CassetteMode } from "./api-key.ts";
import { writeFileAtomically } from "./cassette.ts";

export type Manifest = {
  recorded_at: string;
  threshold: number;
  tier_one_threshold: number;
  model_requested: string;
  model_answered: string | null;
};

/**
 * Recorded answers do not depend on the threshold, so a replay would stay green
 * after a threshold change; the manifest pins the threshold the recording was
 * scored at so `--enforce-floor` can notice.
 */
export function manifestPath(cassetteDir: string): string {
  return join(cassetteDir, "manifest.json");
}

/** `undefined` when there is no manifest; `Error` when one exists but cannot be trusted. */
export function readManifest(
  cassetteDir: string | undefined,
  mode: CassetteMode,
): Manifest | Error | undefined {
  if (mode === "off" || cassetteDir === undefined) return undefined;
  const path = manifestPath(cassetteDir);
  if (!existsSync(path)) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<Manifest>;
    if (typeof manifest.threshold !== "number") return new Error("manifest.json has no threshold");
    return manifest as Manifest;
  } catch (error) {
    return new Error(`manifest.json is unreadable: ${errorMessage(error)}`);
  }
}

/**
 * A replay scores recorded answers, so only the pin makes a threshold change
 * visible: a pin that is missing is as unsound as one that disagrees. Auto
 * mode replays whatever it has, so a pin that disagrees is a failure there
 * too; a missing one is not, because the run writes it.
 */
export function thresholdPinFailure(
  manifest: Manifest | Error | undefined,
  mode: CassetteMode,
  threshold: number,
): string | undefined {
  if (mode !== "replay" && mode !== "auto") return undefined;
  if (manifest === undefined) {
    return mode === "replay"
      ? "the cassettes have no manifest.json pinning the threshold they were recorded at"
      : undefined;
  }
  if (manifest instanceof Error) return `${manifest.message}; re-record the cassettes`;
  if (manifest.threshold !== threshold)
    return `threshold ${threshold} differs from the recorded ${manifest.threshold}`;
  return undefined;
}

/** Whether this run leaves a pin behind: a fresh recording does, an existing one is never rewritten. */
export function writesManifest(
  mode: CassetteMode,
  manifest: Manifest | Error | undefined,
): boolean {
  return mode === "record" || (mode === "auto" && manifest === undefined);
}

export function writeManifest(
  cassetteDir: string | undefined,
  settings: JudgeSettings,
  model: string | null,
): void {
  if (cassetteDir === undefined) return;
  const manifest: Manifest = {
    recorded_at: new Date().toISOString(),
    threshold: settings.threshold,
    tier_one_threshold: settings.tierOneThreshold,
    model_requested: settings.model,
    model_answered: model,
  };
  mkdirSync(cassetteDir, { recursive: true });
  writeFileAtomically(manifestPath(cassetteDir), `${JSON.stringify(manifest, null, 2)}\n`);
}
