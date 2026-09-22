import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Context } from "../context.ts";
import { UsageError } from "../errors.ts";
import { errorMessage } from "../util.ts";
import { type DiffSummary, parseUnifiedDiff } from "./diff.ts";
import { type DocSummary, readDoc } from "./doc.ts";
import { extractKeywords } from "./keywords.ts";
import { type PlanSummary, readPlan } from "./plan.ts";

export type ChannelInput = {
  activity: string | undefined;
  concepts: string[];
  decisions: string[];
  domains: string[];
  modules: string[];
  paths: string[];
  diffPath: string | undefined;
  planPath: string | undefined;
  docPath: string | undefined;
};

export type WorkState = {
  activity: string | null;
  concepts: string[];
  decisions: string[];
  domains: string[];
  modules: string[];
  paths: string[];
  diff: DiffSummary | null;
  plan: PlanSummary | null;
  doc: DocSummary | null;
  keywords: string[];
};

export function hasAnyChannel(input: ChannelInput): boolean {
  return Boolean(
    input.activity?.trim() ||
      input.concepts.length ||
      input.decisions.length ||
      input.domains.length ||
      input.modules.length ||
      input.paths.length ||
      input.diffPath ||
      input.planPath ||
      input.docPath,
  );
}

export const CHANNEL_HINT =
  "give at least one input channel: an activity sentence, --concept/--decision/--domain/--module/--path, or --diff/--plan/--doc";

/** Normalize every channel into one state and derive the lexical keywords from all of them. */
export async function buildWorkState(input: ChannelInput, ctx: Context): Promise<WorkState> {
  if (!hasAnyChannel(input)) throw new UsageError(CHANNEL_HINT);
  const diff =
    input.diffPath === undefined
      ? null
      : nonEmptyDiff(parseUnifiedDiff(await readDiff(input.diffPath, ctx)));
  if (
    diff === null &&
    input.diffPath !== undefined &&
    !hasAnyChannel({ ...input, diffPath: undefined })
  ) {
    const where = input.diffPath === "-" ? "stdin" : input.diffPath;
    throw new UsageError(`the diff from ${where} is empty; ${CHANNEL_HINT}`);
  }
  const plan = input.planPath === undefined ? null : readOrUsage(input.planPath, readPlan);
  const doc = input.docPath === undefined ? null : readOrUsage(input.docPath, readDoc);
  const clean = (list: string[]) => list.map((s) => s.trim()).filter(Boolean);
  const state: WorkState = {
    activity: input.activity?.trim() || null,
    concepts: clean(input.concepts),
    decisions: clean(input.decisions),
    domains: clean(input.domains),
    modules: clean(input.modules),
    paths: clean(input.paths),
    diff,
    plan,
    doc,
    keywords: [],
  };
  state.keywords = extractKeywords(
    state.activity,
    ...state.concepts,
    ...state.decisions,
    ...state.domains,
    ...state.modules,
    ...state.paths,
    ...(diff ? [...diff.files, ...diff.symbols, ...diff.hunks] : []),
    ...(plan
      ? [plan.title, plan.topic, plan.summary, ...plan.requirements, ...plan.decisions]
      : []),
    ...(doc ? [doc.title, ...doc.applies_when, ...doc.tags, doc.excerpt] : []),
  );
  return state;
}

/** A diff with no files, hunks, or content carries no work context. */
function nonEmptyDiff(diff: DiffSummary): DiffSummary | null {
  return diff.files.length || diff.hunks.length || diff.excerpt ? diff : null;
}

/** Jev reads the state once per request; a work context this large leaves no room for candidates. */
export const MAX_WORK_TOKENS = 24_000;

export function assertWorkFits(work: Record<string, unknown>): void {
  const tokens = Math.ceil(JSON.stringify(work).length / 3);
  if (tokens > MAX_WORK_TOKENS) {
    throw new UsageError(
      `the work context is about ${tokens} tokens; the limit is ${MAX_WORK_TOKENS}. Trim the --diff or --plan input or pass fewer paths`,
    );
  }
}

async function readDiff(path: string, ctx: Context): Promise<string> {
  if (path === "-") return ctx.readStdin();
  return readOrUsage(path, (p) => readFileSync(p, "utf8"));
}

function readOrUsage<T>(path: string, read: (path: string) => T): T {
  try {
    return read(path);
  } catch (error) {
    throw new UsageError(`cannot read ${basename(path)}: ${errorMessage(error)}`);
  }
}

/** The state as Jev sees it: every channel, no lexical keywords (those are the prefilter's). */
export function judgeState(state: WorkState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (state.activity) out.activity = state.activity;
  if (state.concepts.length) out.concepts = state.concepts;
  if (state.decisions.length) out.decisions = state.decisions;
  if (state.domains.length) out.domains = state.domains;
  if (state.modules.length) out.modules = state.modules;
  if (state.paths.length) out.paths = state.paths;
  if (state.diff) out.diff = state.diff;
  if (state.plan) {
    out.plan = {
      title: state.plan.title,
      topic: state.plan.topic,
      summary: state.plan.summary,
      requirements: state.plan.requirements,
      decisions: state.plan.decisions,
      text: state.plan.text,
    };
  }
  if (state.doc) {
    out.draft_learning = {
      title: state.doc.title,
      applies_when: state.doc.applies_when,
      tags: state.doc.tags,
      excerpt: state.doc.excerpt,
    };
  }
  return out;
}
