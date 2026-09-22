import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { cassetteFetch } from "../../src/judge/cassette.ts";
import { createJudge, type Judge } from "../../src/judge/client.ts";

const CASSETTES = resolve(import.meta.dir, "../fixtures/cassettes");

/**
 * A judge that replays recorded cassettes by default. Set RECORD_CASSETTES=1
 * with a real TYPESAFE_API_KEY to re-record after changing question wording
 * or fixtures; the key is never written anywhere.
 */
export function testJudge(name: string, options: { parallel?: number; spy?: Fetch } = {}): Judge {
  const dir = join(CASSETTES, name);
  const recording = process.env.RECORD_CASSETTES === "1" && Boolean(process.env.TYPESAFE_API_KEY);
  if (recording) mkdirSync(dir, { recursive: true });
  const upstream: Fetch = options.spy ?? fetch;
  const fetchImpl = recording
    ? cassetteFetch("record", dir, upstream)
    : cassetteFetch("replay", dir, options.spy ?? failIfCalled);
  return createJudge({
    apiKey: recording ? (process.env.TYPESAFE_API_KEY as string) : "replay-placeholder",
    fetch: fetchImpl,
    parallel: options.parallel ?? 4,
    retry: recording ? {} : { maxRetries: 0 },
  });
}

const failIfCalled: Fetch = async () => {
  throw new Error("cassette replay must not reach the network");
};
