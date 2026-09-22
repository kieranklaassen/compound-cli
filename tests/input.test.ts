import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Context } from "../src/context.ts";
import { UsageError } from "../src/errors.ts";
import { parseUnifiedDiff } from "../src/input/diff.ts";
import { extractKeywords, keywordOverlap } from "../src/input/keywords.ts";
import { readPlan } from "../src/input/plan.ts";
import { buildWorkState, type ChannelInput, judgeState } from "../src/input/work-state.ts";

const INPUT = resolve(import.meta.dir, "fixtures/input");

const EMPTY: ChannelInput = {
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

function ctx(stdin = ""): Context {
  return {
    cwd: process.cwd(),
    env: {},
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => stdin,
    isTTY: false,
  };
}

describe("buildWorkState", () => {
  test("activity only yields the activity and keywords from it", async () => {
    const state = await buildWorkState(
      { ...EMPTY, activity: "Add retry with backoff to the HTTP client" },
      ctx(),
    );
    expect(state.activity).toBe("Add retry with backoff to the HTTP client");
    expect(state.keywords).toEqual(["retry", "backoff", "http", "client"]);
    expect(state.diff).toBeNull();
  });

  test("repeated structured flags are kept in order and trimmed", async () => {
    const state = await buildWorkState(
      { ...EMPTY, concepts: [" a ", "b"], modules: ["sync"] },
      ctx(),
    );
    expect(state.concepts).toEqual(["a", "b"]);
    expect(state.modules).toEqual(["sync"]);
    expect(state.activity).toBeNull();
  });

  test("a diff file yields paths, symbols, and hunk contexts", async () => {
    const state = await buildWorkState({ ...EMPTY, diffPath: join(INPUT, "sample.diff") }, ctx());
    expect(state.diff?.files).toEqual(["src/judge/client.ts", "tests/judge.test.ts"]);
    expect(state.diff?.symbols).toContain("askWithRetry");
    expect(state.diff?.hunks[0]).toContain("JudgeClient");
    expect(state.diff?.added_lines).toBe(11);
    expect(state.diff?.removed_lines).toBe(3);
    expect(state.keywords).toContain("askwithretry");
    expect(state.keywords).toContain("client.ts");
  });

  test("--diff - reads the diff from stdin", async () => {
    const stdin =
      "diff --git a/lib/x.rb b/lib/x.rb\n--- a/lib/x.rb\n+++ b/lib/x.rb\n@@ -1 +1 @@\n+def rotate_certificate\n";
    const state = await buildWorkState({ ...EMPTY, diffPath: "-" }, ctx(stdin));
    expect(state.diff?.files).toEqual(["lib/x.rb"]);
    expect(state.diff?.symbols).toEqual(["rotate_certificate"]);
  });

  test("a plan yields title, summary, requirements, and decision labels", async () => {
    const state = await buildWorkState({ ...EMPTY, planPath: join(INPUT, "plan.md") }, ctx());
    expect(state.plan?.title).toBe("Retry budget");
    expect(state.plan?.topic).toBe("retry-budget");
    expect(state.plan?.summary).toContain("honors Retry-After");
    expect(state.plan?.requirements).toHaveLength(3);
    expect(state.plan?.decisions).toEqual(["Six retries, capped at twenty seconds."]);
  });

  test("a draft learning yields frontmatter and an excerpt", async () => {
    const state = await buildWorkState(
      { ...EMPTY, docPath: join(INPUT, "draft-learning.md") },
      ctx(),
    );
    expect(state.doc?.title).toBe("Honor Retry-After before your own backoff");
    expect(state.doc?.applies_when).toEqual(["Calling a rate-limited HTTP API from a batch job"]);
    expect(state.doc?.excerpt).toContain("## Prevention");
  });

  test("no channel at all is a usage error naming the channels", async () => {
    await expect(buildWorkState(EMPTY, ctx())).rejects.toBeInstanceOf(UsageError);
    await expect(buildWorkState(EMPTY, ctx())).rejects.toThrow(/--concept/);
  });

  test("an unreadable artifact path is a usage error", async () => {
    await expect(
      buildWorkState({ ...EMPTY, planPath: join(INPUT, "nope.md") }, ctx()),
    ).rejects.toThrow(/cannot read nope\.md/);
  });

  test("judgeState drops keywords and empty channels", async () => {
    const state = await buildWorkState({ ...EMPTY, activity: "x y z", concepts: ["c"] }, ctx());
    expect(judgeState(state)).toEqual({ activity: "x y z", concepts: ["c"] });
  });
});

describe("extractKeywords", () => {
  test("drops stopwords, short tokens, duplicates, and keeps identifiers whole", () => {
    expect(
      extractKeywords("Add the draft_message_id index to the sync job, then add it again"),
    ).toEqual(["draft_message_id", "draft", "message", "index", "sync", "job"]);
  });

  test("keeps paths whole and adds their segments", () => {
    expect(extractKeywords("docs/solutions/cli/exit-codes.md")).toEqual([
      "docs/solutions/cli/exit-codes.md",
      "docs",
      "solutions",
      "cli",
      "exit-codes.md",
      "exit",
      "codes",
    ]);
  });

  test("keywordOverlap returns the keywords present in a text", () => {
    expect(keywordOverlap(["retry", "backoff", "gmail"], "Retry with backoff")).toEqual([
      "retry",
      "backoff",
    ]);
  });
});

describe("parseUnifiedDiff and readPlan", () => {
  test("an empty diff yields empty summaries", () => {
    expect(parseUnifiedDiff("")).toEqual({
      files: [],
      symbols: [],
      hunks: [],
      added_lines: 0,
      removed_lines: 0,
      excerpt: "",
    });
  });

  test("readPlan falls back to the first paragraph without a Summary heading", () => {
    const summary = readPlan(join(INPUT, "draft-learning.md"));
    expect(summary.summary).toContain("A batch job hammered");
  });
});
