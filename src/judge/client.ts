import {
  APIError,
  APIUserAbortError,
  type ChoiceResponse,
  type EntryType,
  type Fetch,
  type NoulResponse,
  type Questions,
  type RetryPolicy,
  type ScoreResponse,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { Env } from "../context.ts";
import { JudgeError } from "../errors.ts";
import { DEFAULTS } from "../find/defaults.ts";
import { errorMessage } from "../util.ts";
import { CASSETTE_DIR_VARIABLE, cassetteMode, requireApiKey } from "./api-key.ts";
import { planBatches } from "./batching.ts";
import { CASSETTE_MISS_MARKER, cassetteFetch } from "./cassette.ts";
import { Semaphore } from "./semaphore.ts";
import { UsageTracker } from "./usage.ts";

export type Answer = NoulResponse | ChoiceResponse | ScoreResponse;
export type Answers = Record<string, Answer>;

export type Judge = {
  readonly model: string;
  readonly usage: UsageTracker;
  /** Ask every question about one state, batching under the request budget. Fails whole: no partial answers. */
  ask(state: unknown, questions: Questions): Promise<Answers>;
};

export type JudgeOptions = {
  apiKey: string;
  model?: string;
  parallel?: number;
  fetch?: Fetch;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
};

/**
 * One attempt plus six retries on 408, 429, and 5xx (529 included). Retry-After
 * is honored up to the same cap as the local backoff, so a throttling server
 * cannot park a request for a minute at a time.
 */
const RETRY: Partial<RetryPolicy> = {
  maxRetries: 6,
  backoffInitialMs: 400,
  backoffMaxMs: 20_000,
  respectRetryAfter: true,
  maxRetryAfterMs: 20_000,
};

export function createJudge(options: JudgeOptions): Judge {
  const model = options.model ?? DEFAULTS.model;
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: model,
    logLevel: "off",
    timeout: options.timeoutMs ?? 60_000,
    retry: { ...RETRY, ...options.retry },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const semaphore = new Semaphore(options.parallel ?? DEFAULTS.parallel);
  const usage = new UsageTracker();

  return {
    model,
    usage,
    async ask(state, questions) {
      const batches = planBatches(state, questions);
      // One failure aborts the siblings: no partial answers, and no spending
      // on judgments the caller will never see (plan R29).
      const controller = new AbortController();
      const results = await Promise.all(
        batches.map((keys) =>
          semaphore.run(async () => {
            const subset: Questions = {};
            for (const key of keys) {
              const question = questions[key];
              if (question) subset[key] = question;
            }
            try {
              const result = await client.systemOne(
                { state: state as EntryType, questions: subset, model },
                { signal: controller.signal },
              );
              usage.record(result);
              return result.answers as Answers;
            } catch (error) {
              const judgeError = toJudgeError(error);
              if (!controller.signal.aborted) controller.abort(judgeError);
              throw judgeError;
            }
          }, controller.signal),
        ),
      );
      const merged: Answers = {};
      for (const answers of results) {
        for (const [key, answer] of Object.entries(answers)) {
          if (key in merged) throw new JudgeError(`duplicate answer key across batches: ${key}`);
          merged[key] = answer;
        }
      }
      for (const key of Object.keys(questions)) {
        if (!(key in merged)) throw new JudgeError(`TypeSafe answered without ${key}`);
      }
      return merged;
    },
  };
}

/** Build a judge from the environment: key check, cassette mode, model, parallelism. */
export function judgeFromEnv(
  env: Env,
  options: { model?: string; parallel?: number; fetch?: Fetch } = {},
): Judge {
  const apiKey = requireApiKey(env);
  const mode = cassetteMode(env);
  let fetchImpl = options.fetch;
  let retry: Partial<RetryPolicy> | undefined;
  if (mode !== "off") {
    const dir = env[CASSETTE_DIR_VARIABLE]?.trim();
    if (!dir) throw new JudgeError(`${CASSETTE_DIR_VARIABLE} must be set when cassettes are on`);
    fetchImpl = cassetteFetch(mode, dir, options.fetch ?? fetch);
    if (mode === "replay") retry = { maxRetries: 0 };
  }
  return createJudge({
    apiKey,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.parallel !== undefined ? { parallel: options.parallel } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(retry ? { retry } : {}),
  });
}

function toJudgeError(error: unknown): JudgeError {
  if (error instanceof JudgeError) return error;
  if (error instanceof APIUserAbortError && error.cause instanceof JudgeError) return error.cause;
  if (error instanceof APIError) {
    const body = error.body;
    if (
      body &&
      typeof body === "object" &&
      (body as { error?: unknown }).error === CASSETTE_MISS_MARKER
    ) {
      const miss = body as { hash: string; dir: string; reason?: string };
      return new JudgeError(
        `cassette replay miss: ${miss.reason ?? "no recording"} ${miss.hash} in ${miss.dir} (re-record with COMPOUND_CASSETTE_MODE=record)`,
        { status: error.status, cause: error },
      );
    }
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    return new JudgeError(`HTTP ${error.status}: ${text.slice(0, 300)}`, {
      status: error.status,
      cause: error,
    });
  }
  return new JudgeError(errorMessage(error).slice(0, 300), { cause: error });
}

/** An expected rubric level normalized to 0..1 (top level = 1). */
export function scoreOf(answers: Answers, key: string): number {
  const answer = answers[key];
  if (answer?.type !== "score") throw new JudgeError(`expected a score answer for ${key}`);
  const levels = Object.keys(answer.legend).length;
  return levels > 1 ? answer.score / (levels - 1) : answer.score;
}

export function noulOf(answers: Answers, key: string): number {
  const answer = answers[key];
  if (answer?.type !== "noul") throw new JudgeError(`expected a noul answer for ${key}`);
  return answer.noul;
}

export function choiceOf(answers: Answers, key: string): ChoiceResponse | undefined {
  const answer = answers[key];
  return answer?.type === "choice" ? answer : undefined;
}
