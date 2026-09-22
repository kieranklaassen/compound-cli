import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../../src/context.ts";
import type { ChannelInput } from "../../src/input/work-state.ts";

/** A throwaway directory holding the given files (paths relative to its root). */
const created: string[] = [];

/** Remove every temp directory handed out so far; the test preload calls this once per run. */
export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A throwaway directory under the OS temp dir, removed by the preload after the run. */
export function tempDir(prefix = "compound-cli-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function tempRepo(files: Record<string, string>, prefix = "compound-cli-"): string {
  const root = tempDir(prefix);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/** A silent, non-TTY context whose stdin returns the given text. */
export function fakeContext(overrides: Partial<Context> = {}, stdin = ""): Context {
  return {
    cwd: process.cwd(),
    env: {},
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => stdin,
    isTTY: false,
    confirm: async () => false,
    ...overrides,
  };
}

export const NO_CHANNELS: ChannelInput = {
  activity: undefined,
  concepts: [],
  decisions: [],
  domains: [],
  modules: [],
  paths: [],
  diffPath: undefined,
  planPath: undefined,
  docPath: undefined,
};

/**
 * Cassette environment for CLI subprocess tests: replay by default; with
 * RECORD_CASSETTES=1 and a real TYPESAFE_API_KEY the run records instead.
 */
export function cassetteEnv(dir: string): Record<string, string> {
  const recording = process.env.RECORD_CASSETTES === "1" && Boolean(process.env.TYPESAFE_API_KEY);
  if (!recording) return { COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: dir };
  return {
    COMPOUND_CASSETTE_MODE: "record",
    COMPOUND_CASSETTE_DIR: dir,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY as string,
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai",
  };
}
