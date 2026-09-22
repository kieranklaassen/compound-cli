import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choice, type Fetch, noul, type Questions } from "@typesafe-ai/sdk";
import { JudgeError } from "../src/errors.ts";
import { MAX_NOULS_PER_REQUEST, planBatches, REQUEST_TOKEN_BUDGET } from "../src/judge/batching.ts";
import { canonicalJson, cassetteFetch, requestHash } from "../src/judge/cassette.ts";
import { createJudge, judgeFromEnv, noulOf } from "../src/judge/client.ts";
import { Semaphore } from "../src/judge/semaphore.ts";

import { tempDir } from "./helpers/fixtures.ts";

const KEY = "test-key-never-stored-1234567890";
const FAST_RETRY = { backoffInitialMs: 1, backoffMaxMs: 2, backoffJitter: 0 };

type Recorded = {
  body: { model: string; state: unknown; questions: Record<string, unknown> };
  auth: string | null;
};

type ServerOptions = {
  /** Per-request delay; a function receives the 0-based request index. */
  delayMs?: number | ((index: number) => number);
  omitKey?: string;
  wrongTypeKey?: string;
};

/** A fake TypeSafe server: records every request and answers each noul with 0.75. */
function fakeServer(statuses: number[] = [], options: ServerOptions = {}) {
  const requests: Recorded[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl: Fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Recorded["body"];
    requests.push({ body, auth: headers.get("authorization") });
    const index = requests.length - 1;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve, reject) => {
      const delay =
        typeof options.delayMs === "function" ? options.delayMs(index) : (options.delayMs ?? 5);
      const timer = setTimeout(resolve, delay);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
    inFlight--;
    const status = statuses.shift() ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: `status ${status}` }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions)) {
      if (key === options.omitKey) continue;
      const type = key === options.wrongTypeKey ? "choice" : (question as { type: string }).type;
      answers[key] =
        type === "choice"
          ? { type: "choice", choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }
          : { type: "noul", noul: 0.75 };
    }
    const n = Object.keys(answers).length;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 100 + n * 10, output_tokens: n },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch: fetchImpl, requests, peak: () => peak };
}

function nouls(count: number): Questions {
  const out: Questions = {};
  for (let i = 0; i < count; i++) out[`q${i}`] = noul(`Question ${i}`);
  return out;
}

describe("planBatches", () => {
  test("splits 450 nouls into three requests of at most 200", () => {
    const batches = planBatches({ tiny: true }, nouls(450));
    expect(batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(Object.keys(nouls(450)));
    expect(MAX_NOULS_PER_REQUEST).toBe(200);
  });

  test("a large state leaves less room for questions", () => {
    const state = { text: "x".repeat(40_000 * 3) };
    const questions: Questions = {};
    // Each question costs about 100 tokens; 8,000 tokens of room allows roughly 80 per batch.
    for (let i = 0; i < 200; i++) questions[`q${i}`] = noul("Q".repeat(270));
    const batches = planBatches(state, questions);
    expect(batches.length).toBeGreaterThan(2);
    expect(batches.every((b) => b.length < 90)).toBe(true);
  });

  test("a state over the budget is a judge error", () => {
    expect(() => planBatches({ text: "x".repeat(REQUEST_TOKEN_BUDGET * 3 + 3) }, nouls(1))).toThrow(
      JudgeError,
    );
  });

  test("a batch with a choice is never split", () => {
    const questions = { ...nouls(3), where: choice("Where?", { a: null, b: null }) };
    expect(planBatches({}, questions)).toEqual([["q0", "q1", "q2", "where"]]);
  });
});

describe("createJudge", () => {
  test("merges answers across batches under the original keys and sums usage", async () => {
    const server = fakeServer();
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    const answers = await judge.ask({ same: "state" }, nouls(450));
    expect(Object.keys(answers)).toHaveLength(450);
    expect(noulOf(answers, "q449")).toBe(0.75);
    expect(server.requests).toHaveLength(3);
    expect(server.requests.every((r) => JSON.stringify(r.body.state) === '{"same":"state"}')).toBe(
      true,
    );
    expect(server.requests.every((r) => r.body.model === "jev-latest")).toBe(true);
    expect(server.requests[0]?.auth).toBe(`Bearer ${KEY}`);
    const usage = judge.usage.snapshot();
    expect(usage.requests).toBe(3);
    expect(usage.input_tokens).toBe(100 * 3 + 450 * 10);
    expect(usage.output_tokens).toBe(450);
    expect(usage.estimated_usd).toBeCloseTo(usage.input_tokens * 42e-9, 8);
    expect(usage.model).toBe("jev-1.13.0");
  });

  test("bounds in-flight requests to --parallel", async () => {
    const server = fakeServer();
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, parallel: 2, retry: FAST_RETRY });
    await judge.ask({}, nouls(1000));
    expect(server.requests).toHaveLength(5);
    expect(server.peak()).toBe(2);
  });

  test("retries a 429 that carries Retry-After and then succeeds", async () => {
    const server = fakeServer([429]);
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    const answers = await judge.ask({}, nouls(2));
    expect(noulOf(answers, "q0")).toBe(0.75);
    expect(server.requests).toHaveLength(2);
  });

  test("exhausted retries on 500 are a judge failure with no partial answers", async () => {
    const server = fakeServer(Array(20).fill(500));
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    await expect(judge.ask({}, nouls(2))).rejects.toBeInstanceOf(JudgeError);
    await expect(judge.ask({}, nouls(2))).rejects.toThrow(/HTTP 500/);
    // Seven attempts (one plus six retries) for the first call.
    expect(server.requests.length).toBeGreaterThanOrEqual(7);
  });

  test("a 401 is not retried and names the status", async () => {
    const server = fakeServer([401]);
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    await expect(judge.ask({}, nouls(1))).rejects.toThrow(/HTTP 401/);
    expect(server.requests).toHaveLength(1);
  });

  test("one failing batch fails the whole ask", async () => {
    const server = fakeServer([200, 400]);
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, parallel: 1, retry: FAST_RETRY });
    await expect(judge.ask({}, nouls(250))).rejects.toThrow(/HTTP 400/);
  });

  test("a failing batch aborts its siblings instead of letting them run and bill", async () => {
    // Eight batches, two slots: the first request fails at once, the second is
    // still in flight when the abort arrives, and the remaining six must never
    // be sent. The failing request answers first so the outcome is deterministic.
    const server = fakeServer([400], { delayMs: (index) => (index === 0 ? 5 : 80) });
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, parallel: 2, retry: FAST_RETRY });
    const started = performance.now();
    await expect(judge.ask({}, nouls(1600))).rejects.toThrow(/HTTP 400/);
    expect(performance.now() - started).toBeLessThan(200);
    expect(server.requests.length).toBeLessThanOrEqual(2);
    expect(judge.usage.snapshot().requests).toBe(0);
  });

  test("an answer set missing a key is a judge failure, not a zero score", async () => {
    const server = fakeServer([], { omitKey: "q1" });
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    await expect(judge.ask({}, nouls(3))).rejects.toThrow(/answered without q1/);
  });

  test("a wrongly typed answer is rejected by noulOf", async () => {
    const server = fakeServer([], { wrongTypeKey: "q0" });
    const judge = createJudge({ apiKey: KEY, fetch: server.fetch, retry: FAST_RETRY });
    const answers = await judge.ask({}, nouls(2));
    expect(() => noulOf(answers, "q0")).toThrow(/expected a noul answer/);
  });
});

describe("cassettes", () => {
  test("record writes one file per request without key material; replay returns the same answers offline", async () => {
    const dir = tempDir("compound-cli-cassette-");
    const server = fakeServer();
    const recorder = createJudge({
      apiKey: KEY,
      fetch: cassetteFetch("record", dir, server.fetch),
      retry: FAST_RETRY,
    });
    const recorded = await recorder.ask({ s: 1 }, nouls(250));
    expect(server.requests).toHaveLength(2);
    const files = readdirSync(dir);
    expect(files).toHaveLength(2);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain(KEY);
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(JSON.parse(text).request_hash).toBe(file.replace(/\.json$/, ""));
    }
    const failIfCalled: Fetch = async () => {
      throw new Error("replay must not touch the network");
    };
    const replayer = createJudge({
      apiKey: "anything",
      fetch: cassetteFetch("replay", dir, failIfCalled),
      retry: { maxRetries: 0 },
    });
    const replayed = await replayer.ask({ s: 1 }, nouls(250));
    expect(replayed).toEqual(recorded);
  });

  test("a corrupted cassette is reported as an unreadable recording, not a network error", async () => {
    const dir = tempDir("compound-cli-cassette-");
    const hash = requestHash({ model: "jev-latest", state: { s: 1 }, questions: nouls(1) });
    writeFileSync(join(dir, `${hash}.json`), "{ not json");
    const judge = createJudge({
      apiKey: "x",
      fetch: cassetteFetch("replay", dir),
      retry: { maxRetries: 0 },
    });
    await expect(judge.ask({ s: 1 }, nouls(1))).rejects.toThrow(/unreadable recording/);
  });

  test("a replay miss is a judge failure naming the hash", async () => {
    const dir = tempDir("compound-cli-cassette-");
    const judge = createJudge({
      apiKey: "x",
      fetch: cassetteFetch("replay", dir),
      retry: { maxRetries: 0 },
    });
    await expect(judge.ask({ never: "recorded" }, nouls(1))).rejects.toThrow(
      /cassette replay miss: no recording [0-9a-f]{64}/,
    );
  });

  test("the request hash ignores key order", () => {
    expect(requestHash({ a: 1, b: [1, { d: 2, c: 3 }] })).toBe(
      requestHash({ b: [1, { c: 3, d: 2 }], a: 1 }),
    );
    expect(canonicalJson({ b: undefined, a: null })).toBe('{"a":null}');
  });

  test("judgeFromEnv uses a placeholder key in replay mode and requires a cassette dir", () => {
    const dir = tempDir("compound-cli-cassette-");
    expect(() => judgeFromEnv({ COMPOUND_CASSETTE_MODE: "replay" })).toThrow(
      /COMPOUND_CASSETTE_DIR/,
    );
    const judge = judgeFromEnv({ COMPOUND_CASSETTE_MODE: "replay", COMPOUND_CASSETTE_DIR: dir });
    expect(judge.model).toBe("jev-latest");
  });
});

describe("Semaphore", () => {
  test("rejects a non-positive limit", () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
  });
});
