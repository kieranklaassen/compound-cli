import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCeConfig } from "../src/config/ce-config.ts";
import { resolveRepoRoot } from "../src/config/repo-root.ts";
import { UsageError } from "../src/errors.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");

function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "compound-cli-config-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe("loadCeConfig", () => {
  test("config.local.yaml docs_root wins over config.yaml", () => {
    const config = loadCeConfig(join(FIXTURES, "config-layers"));
    expect(config.docsRoot).toBe("knowledge");
    expect(config.docsRootSource).toBe("config.local.yaml");
    expect(config.docsRootAbs).toBe(join(FIXTURES, "config-layers", "knowledge"));
  });

  test("packs from both layers concatenate, config.yaml first, with labels", () => {
    const config = loadCeConfig(join(FIXTURES, "config-layers"));
    expect(config.packs.map((p) => p.source)).toEqual([
      "https://github.com/example/packs/tree/v1/packs",
      "~/some/packs",
    ]);
    expect(config.packs[0]?.pack).toEqual(["alpha", "beta"]);
    expect(config.packs[1]?.id).toBe("renamed");
    expect(config.packs[0]?.label).toMatch(/^config\.yaml:\d+$/);
    expect(config.errors.join("\n")).toContain("unknown packs entry key `unknown_key:`");
  });

  test("no config files resolves docs_root to docs with no packs", () => {
    const config = loadCeConfig(join(FIXTURES, "empty-repo"));
    expect(config.docsRoot).toBe("docs");
    expect(config.docsRootSource).toBe("default");
    expect(config.packs).toEqual([]);
    expect(config.errors).toEqual([]);
  });

  test("pack_sources are read from the local layer", () => {
    const config = loadCeConfig(join(FIXTURES, "corpus"));
    expect(config.packSources).toEqual([
      { source: "packs", label: expect.stringMatching(/^config\.local\.yaml:\d+$/) },
    ]);
  });

  test("a docs_root outside the repository fails naming docs_root and the value", () => {
    const root = tempRepo({ ".compound-engineering/config.yaml": "docs_root: ../outside\n" });
    expect(() => loadCeConfig(root)).toThrow(UsageError);
    expect(() => loadCeConfig(root)).toThrow(/docs_root "\.\.\/outside"/);
  });

  test("a docs_root equal to the repository root fails", () => {
    const root = tempRepo({ ".compound-engineering/config.yaml": "docs_root: .\n" });
    expect(() => loadCeConfig(root)).toThrow(/may not be the repository root/);
  });

  test("a malformed packs value is an error, not an absent declaration", () => {
    const root = tempRepo({ ".compound-engineering/config.yaml": "packs: some/path\n" });
    const config = loadCeConfig(root);
    expect(config.packs).toEqual([]);
    expect(config.errors[0]).toContain("`packs:` must be a block list");
  });
});

describe("resolveRepoRoot", () => {
  test("an explicit override wins and must be a directory", () => {
    expect(resolveRepoRoot(process.cwd(), join(FIXTURES, "corpus")).source).toBe("override");
    expect(() => resolveRepoRoot(process.cwd(), join(FIXTURES, "nope"))).toThrow(UsageError);
  });

  test("a plain directory outside any checkout resolves to itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "compound-cli-root-"));
    const result = resolveRepoRoot(dir);
    expect(result.root).toBe(dir);
    expect(result.source).toBe("cwd");
  });
});
