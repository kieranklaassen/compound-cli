import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { tempDir } from "./helpers/fixtures.ts";
import { runCli } from "./helpers/run-cli.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const EMPTY_HOME = tempDir("compound-cli-home-");

describe("compound doctor", () => {
  test("reports a missing key without failing, plus corpus health", async () => {
    const result = await runCli(["doctor", "--no-sources", "--root", CORPUS], {
      env: { HOME: EMPTY_HOME },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("TYPESAFE_API_KEY: missing");
    expect(result.stdout).toContain("learnings: 7");
    expect(result.stdout).toContain("missing applies_when: 3");
    expect(result.stdout).toContain("docs/solutions/email/gmail-sync-null-bytes.md");
    expect(result.stdout).toContain("malformed frontmatter: 1");
    expect(result.stdout).toContain("docs/solutions/broken/bad-yaml.md");
    expect(result.stdout).toContain("local-rules: 2 rules, 1 nested rule-shaped");
    expect(result.stdout).not.toContain("apikey");
  });

  test("--json carries the documented keys and never the key value", async () => {
    const result = await runCli(["doctor", "--json", "--no-sources", "--root", CORPUS], {
      env: { HOME: EMPTY_HOME, TYPESAFE_API_KEY: "secret-value-123" },
    });
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json).sort()).toEqual([
      "cache",
      "docs_root",
      "key",
      "known_sources",
      "learnings",
      "packs",
      "repository",
    ]);
    expect(json.key.present).toBe(true);
    expect(result.stdout).not.toContain("secret-value-123");
    expect(json.learnings.missing_date).toEqual([]);
    expect(json.packs.roots[0].id).toBe("local-rules");
    expect(json.known_sources.map((s: { source: string }) => s.source)).toEqual([
      "https://github.com/EveryInc/compound-packs.git@main",
      "packs",
    ]);
    expect(json.known_sources[1]).toMatchObject({ kind: "local", status: "present", packs: 2 });
  });

  test("--strict exits 3 when the key is missing", async () => {
    const result = await runCli(["doctor", "--strict", "--no-sources", "--root", CORPUS], {
      env: { HOME: EMPTY_HOME },
    });
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("TYPESAFE_API_KEY: missing");
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });
});
