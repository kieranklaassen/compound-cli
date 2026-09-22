import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { firstHeading, parseFrontmatter } from "../src/corpus/frontmatter.ts";
import { loadLearnings } from "../src/corpus/learnings.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");

describe("loadLearnings", () => {
  const load = loadLearnings(CORPUS, join(CORPUS, "docs"));

  test("walks nested category folders and yields repo-relative paths", () => {
    expect(load.exists).toBe(true);
    expect(load.candidates.map((c) => c.path)).toEqual([
      "docs/solutions/cli/exit-codes-for-expected-empty-results.md",
      "docs/solutions/email/gmail-sync-null-bytes.md",
      "docs/solutions/frontend/inertia-react-package-alignment.md",
      "docs/solutions/http/retry-with-backoff-honoring-retry-after.md",
      "docs/solutions/notitle.md",
      "docs/solutions/testing/flaky-timeouts-from-global-fsmonitor.md",
      "docs/solutions/workflow/pass-paths-not-content-to-subagents.md",
    ]);
    expect(load.candidates.every((c) => c.kind === "solution")).toBe(true);
  });

  test("invalid frontmatter is skipped and reported, never thrown", () => {
    expect(load.malformed).toHaveLength(1);
    expect(load.malformed[0]?.path).toBe("docs/solutions/broken/bad-yaml.md");
    expect(load.warnings[0]).toContain("docs/solutions/broken/bad-yaml.md");
  });

  test("a learning without title takes its first heading", () => {
    const candidate = load.candidates.find((c) => c.path === "docs/solutions/notitle.md");
    expect(candidate?.title).toBe("A learning whose title comes from its heading");
  });

  test("applies_when and tags are normalized to string lists", () => {
    const candidate = load.candidates.find((c) => c.path.includes("exit-codes"));
    expect(candidate?.appliesWhen).toHaveLength(2);
    expect(candidate?.tags).toEqual(["agent-cli", "exit-codes", "error-handling"]);
    expect(candidate?.bodyStartLine).toBe(16);
  });

  test("a missing solutions directory reports exists false with no candidates", () => {
    const empty = loadLearnings(CORPUS, join(CORPUS, "nowhere"));
    expect(empty.exists).toBe(false);
    expect(empty.candidates).toEqual([]);
  });
});

describe("parseFrontmatter", () => {
  test("a document without frontmatter is all body", () => {
    const parsed = parseFrontmatter("# Title\n\nbody");
    expect(parsed).toEqual({
      data: {},
      body: "# Title\n\nbody",
      bodyStartLine: 1,
      hasFrontmatter: false,
    });
  });

  test("an unclosed block is an error", () => {
    expect(parseFrontmatter("---\ntitle: x\n")).toEqual({
      error: "frontmatter block never closes",
    });
  });

  test("a non-mapping block is an error", () => {
    expect(parseFrontmatter("---\n- a\n- b\n---\n")).toEqual({
      error: "frontmatter is not a mapping",
    });
  });

  test("a BOM is not content", () => {
    const parsed = parseFrontmatter("\uFEFF---\ntitle: x\n---\nbody");
    expect("data" in parsed && parsed.data.title).toBe("x");
  });

  test("firstHeading returns the first H1", () => {
    expect(firstHeading("intro\n\n## no\n\n# Yes here\n")).toBe("Yes here");
    expect(firstHeading("nothing")).toBeUndefined();
  });
});
