import type { Question, Questions } from "@typesafe-ai/sdk";
import { JudgeError } from "../errors.ts";

/** Thinkroom's Judge limits: Nouls per request and a conservative token budget. */
export const MAX_NOULS_PER_REQUEST = 200;
export const REQUEST_TOKEN_BUDGET = 48_000;
export const NOUL_OVERHEAD_TOKENS = 8;
const CHARS_PER_TOKEN = 3;

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? null).length / CHARS_PER_TOKEN);
}

/**
 * Split question keys into request-sized batches that share one state. Nouls
 * are independent and may be split; a batch holding any Choice or Score stays
 * whole because those distributions depend on their full option set.
 */
export function planBatches(state: unknown, questions: Questions): string[][] {
  const keys = Object.keys(questions);
  if (keys.length === 0) return [];
  const stateTokens = estimateTokens(state);
  const capacity = REQUEST_TOKEN_BUDGET - stateTokens;
  if (capacity <= 0) {
    throw new JudgeError(
      `state is too large for one request (about ${stateTokens} tokens, budget ${REQUEST_TOKEN_BUDGET})`,
    );
  }
  const allNouls = keys.every((key) => questions[key]?.type === "noul");
  if (!allNouls) {
    const total = keys.reduce((sum, key) => sum + questionTokens(questions[key]), 0);
    if (total > capacity) {
      throw new JudgeError(
        `a batch with Choice or Score questions cannot be split and exceeds the budget (${total} question tokens, ${capacity} available)`,
      );
    }
    return [keys];
  }
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const key of keys) {
    const cost = questionTokens(questions[key]);
    if (current.length && (used + cost > capacity || current.length >= MAX_NOULS_PER_REQUEST)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(key);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

function questionTokens(question: Question | undefined): number {
  if (question === undefined) return NOUL_OVERHEAD_TOKENS;
  return (
    estimateTokens(question.instructions) + estimateTokens(question.criteria) + NOUL_OVERHEAD_TOKENS
  );
}
