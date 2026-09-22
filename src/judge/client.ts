import {
  APIError,
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

/** Retries: six attempts on 408, 429, and 5xx (529 included), honoring Retry-After. */
const RETRY: Partial<RetryPolicy> = {
  maxRetries: 6,
  backoffInitialMs: 400,
  backoffMaxMs: 20_000,
  respectRetryAfter: true,
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
      const results = await Promise.all(
        batches.map((keys) =>
          semaphore.run(async () => {
            const subset: Questions = {};
            for (const key of keys) {
              const question = questions[key];
              if (question) subset[key] = question;
            }
            try {
              const result = await client.systemOne({
                state: state as EntryType,
                questions: subset,
                model,
              });
              usage.record(result);
              return result.answers as Answers;
            } catch (error) {
              throw toJudgeError(error);
            }
          }),
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
  if (error instanceof APIError) {
    const body = error.body;
    if (
      body &&
      typeof body === "object" &&
      (body as { error?: unknown }).error === CASSETTE_MISS_MARKER
    ) {
      const miss = body as { hash: string; dir: string };
      return new JudgeError(
        `cassette replay miss: no recording ${miss.hash} in ${miss.dir} (re-record with COMPOUND_CASSETTE_MODE=record)`,
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

export function noulOf(answers: Answers, key: string): number {
  const answer = answers[key];
  if (answer?.type !== "noul") throw new JudgeError(`expected a noul answer for ${key}`);
  return answer.noul;
}

export function choiceOf(answers: Answers, key: string): ChoiceResponse | undefined {
  const answer = answers[key];
  return answer?.type === "choice" ? answer : undefined;
}
