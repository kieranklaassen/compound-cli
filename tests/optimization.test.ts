import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { loadCeConfig } from "../src/config/ce-config.ts";
import { createGitCache } from "../src/corpus/git-cache.ts";
import { loadLearnings } from "../src/corpus/learnings.ts";
import type { Workspace } from "../src/corpus/load.ts";
import { JudgeError } from "../src/errors.ts";
import { DEFAULTS } from "../src/find/defaults.ts";
import { NO_FILTERS } from "../src/find/filters.ts";
import { buildHits, type JudgeSettings, runFind } from "../src/find/find.ts";
import type { ScoredCandidate } from "../src/find/result.ts";
import { readPlan } from "../src/input/plan.ts";
import { buildWorkState, judgeState } from "../src/input/work-state.ts";
import { type Answers, scoreOf } from "../src/judge/client.ts";
import { bodyHeadings, tierOneRequest, tierTwoRequest } from "../src/judge/questions.ts";
import { fakeContext, NO_CHANNELS, tempRepo } from "./helpers/fixtures.ts";
import { testJudge } from "./helpers/test-judge.ts";

/**
 * Behaviour changed by the kept optimization experiments: the graded tier-two
 * score and its normalization, the per-kind hit thresholds, the plan text in
 * the channel, and the headings tier one reads.
 */

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const INPUT = resolve(import.meta.dir, "fixtures/input");
const load = loadLearnings(CORPUS, join(CORPUS, "docs"));
const workspace: Workspace = {
  repoRoot: CORPUS,
  config: loadCeConfig(CORPUS),
  git: createGitCache({}),
};
const SETTINGS: JudgeSettings = {
  threshold: DEFAULTS.threshold,
  tierOneThreshold: DEFAULTS.tierOneThreshold,
  frontmatterOnly: false,
  batch: DEFAULTS.batch,
  parallel: 2,
  candidateCap: DEFAULTS.candidateCap,
  excerptChars: DEFAULTS.excerptChars,
  model: DEFAULTS.model,
};

function scoreAnswer(score: number, levels: number): Answers {
  const legend: Record<string, string> = {};
  const probabilities: Record<string, number> = {};
  for (let i = 0; i < levels; i++) {
    legend[String(i)] = `level ${i}`;
    probabilities[String(i)] = i === Math.round(score) ? 1 : 0;
  }
  return { relevant: { type: "score", score, confidence: 1, legend, probabilities } } as Answers;
}

describe("graded tier-two score (experiment 9)", () => {
  test("the expected level is normalized so the top level is 1 and the bottom is 0", () => {
    expect(scoreOf(scoreAnswer(3, 4), "relevant")).toBe(1);
    expect(scoreOf(scoreAnswer(0, 4), "relevant")).toBe(0);
    expect(scoreOf(scoreAnswer(2, 4), "relevant")).toBeCloseTo(2 / 3, 6);
    expect(scoreOf(scoreAnswer(1.5, 4), "relevant")).toBeCloseTo(0.5, 6);
  });

  test("a one-level legend cannot be normalized and passes the raw value through", () => {
    expect(scoreOf(scoreAnswer(0, 1), "relevant")).toBe(0);
  });

  test("a non-score answer under the key is a judge error, not a silent zero", () => {
    const answers = { relevant: { type: "noul", noul: 0.9 } } as unknown as Answers;
    expect(() => scoreOf(answers, "relevant")).toThrow(JudgeError);
    expect(() => scoreOf({} as Answers, "relevant")).toThrow(JudgeError);
  });

  test("tier two asks a four-level Score question whose levels are ordered from unrelated to directly applies", () => {
    const candidate = load.candidates.find((c) => c.path.includes("retry-with-backoff"));
    if (!candidate) throw new Error("fixture missing");
    const request = tierTwoRequest({ activity: "x" }, candidate, [
      { heading: "Rule", text: "Retry.", startLine: 1, endLine: 2, truncated: false },
    ]);
    const relevant = request.questions.relevant as { type: string; criteria: string[] };
    expect(relevant.type).toBe("score");
    expect(relevant.criteria).toHaveLength(4);
    expect(relevant.criteria[0]).toMatch(/^Unrelated/);
    expect(relevant.criteria[3]).toMatch(/^Directly applies/);
  });
});

describe("per-kind hit thresholds (experiment 11)", () => {
  const solution = load.candidates[0];
  if (!solution) throw new Error("fixture missing");
  const entry = (kind: ScoredCandidate["candidate"]["kind"], score: number): ScoredCandidate => ({
    candidate: { ...solution, kind, path: `${kind}-${score}` },
    tierOneScore: 0.5,
    score,
    passage: null,
    matchedFields: [],
    overlap: null,
  });

  test("the defaults are 0.6 for learnings and rules and 0.5 for pack suggestions", () => {
    expect(DEFAULTS.threshold).toBe(0.6);
    expect(DEFAULTS.suggestThreshold).toBe(0.5);
  });

  test("a learning at 0.55 is not a hit at 0.6 while a pack suggestion at 0.55 still is", () => {
    const hits = buildHits(
      [entry("solution", 0.55), entry("pack_rule", 0.55), entry("pack_candidate", 0.55)],
      0.6,
    );
    expect(hits.map((h) => h.kind)).toEqual(["pack_candidate"]);
  });

  test("the caller's threshold moves learnings and rules but never pack suggestions", () => {
    const hits = buildHits(
      [entry("solution", 0.45), entry("pack_rule", 0.45), entry("pack_candidate", 0.45)],
      0.4,
    );
    expect(hits.map((h) => h.kind).sort()).toEqual(["pack_rule", "solution"]);
    expect(buildHits([entry("solution", null as unknown as number)], 0.1)).toEqual([]);
  });
});

describe("plan text in the channel (experiment 13)", () => {
  test("the plan body reaches the judge with code fences and comments stripped", async () => {
    const plan = readPlan(join(INPUT, "plan.md"));
    expect(plan.text).toContain("Retry budget");
    expect(plan.text).not.toContain("```");
    const state = await buildWorkState(
      { ...NO_CHANNELS, planPath: join(INPUT, "plan.md") },
      fakeContext(),
    );
    const work = judgeState(state) as { plan: { text: string; summary: string } };
    expect(work.plan.text).toBe(plan.text);
    expect(work.plan.summary.length).toBeGreaterThan(0);
  });

  test("a long plan is bounded to 8000 characters plus an ellipsis", () => {
    const repo = tempRepo({
      "plan.md": `---\ntitle: Long\n---\n# Long\n\n## Summary\n\nShort.\n\n${"word ".repeat(5000)}\n\n<!-- hidden note -->\n\n\`\`\`ts\nconst secret = 1;\n\`\`\`\n`,
    });
    const plan = readPlan(join(repo, "plan.md"));
    expect(plan.text.length).toBe(8003);
    expect(plan.text.endsWith("...")).toBe(true);
    expect(plan.text).not.toContain("hidden note");
    expect(plan.text).not.toContain("const secret");
  });

  test("the plan channel alone, with no activity, is a complete work context", async () => {
    const state = await buildWorkState(
      { ...NO_CHANNELS, planPath: join(INPUT, "plan.md") },
      fakeContext(),
    );
    expect(state.activity).toBeNull();
    expect(state.keywords).toContain("retry");
    const run = await runFind({
      workspace,
      state,
      judge: testJudge("channels"),
      settings: SETTINGS,
      filters: NO_FILTERS,
      mode: "find",
    });
    expect(run.result.hits.map((h) => h.path)).toContain(
      "docs/solutions/http/retry-with-backoff-honoring-retry-after.md",
    );
    expect((run.result.state as { plan: { title: string } }).plan.title).toBe("Retry budget");
  });

  test("the diff channel alone is a complete work context", async () => {
    const state = await buildWorkState(
      { ...NO_CHANNELS, diffPath: join(INPUT, "sample.diff") },
      fakeContext(),
    );
    expect(state.diff?.files.length).toBeGreaterThan(0);
    const run = await runFind({
      workspace,
      state,
      judge: testJudge("channels"),
      settings: SETTINGS,
      filters: NO_FILTERS,
      mode: "find",
    });
    expect(run.result.corpus.solutions).toBe(load.candidates.length);
    expect(run.result.nothing_relevant).toBe(run.result.hits.length === 0);
  });
});

describe("headings in tier one (experiment 16)", () => {
  test("the first eight distinct H2 and H3 headings, bounded to 80 characters", () => {
    const body = `# Title\n\n## Problem\n\ntext\n\n### Root cause\n\n## Problem\n\n## ${"A".repeat(100)}\n\n${Array.from({ length: 10 }, (_, i) => `## Section ${i}`).join("\n\n")}\n`;
    const headings = bodyHeadings(body);
    expect(headings).toHaveLength(8);
    expect(headings.slice(0, 2)).toEqual(["Problem", "Root cause"]);
    expect(headings[2]).toHaveLength(80);
    expect(bodyHeadings("no headings here")).toEqual([]);
  });

  test("tier one puts the headings beside the frontmatter, and omits the key when a body has none", () => {
    const withHeadings = load.candidates.find((c) => c.path.includes("retry-with-backoff"));
    if (!withHeadings) throw new Error("fixture missing");
    const bare = { ...withHeadings, body: "just prose", path: "bare.md" };
    const request = tierOneRequest({ activity: "x" }, [withHeadings, bare]);
    const candidates = request.state.candidates as Record<string, { headings?: string[] }>;
    expect(candidates.c000?.headings?.length).toBeGreaterThan(0);
    expect(candidates.c001?.headings).toBeUndefined();
    expect(request.state.task as string).toContain("section headings");
  });
});
