import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../../src/context.ts";
import type { ChannelInput } from "../../src/input/work-state.ts";

/** A throwaway directory holding the given files (paths relative to its root). */
export function tempRepo(files: Record<string, string>, prefix = "compound-cli-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
