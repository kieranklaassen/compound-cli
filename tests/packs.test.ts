import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCeConfig } from "../src/config/ce-config.ts";
import { cacheKey, createGitCache } from "../src/corpus/git-cache.ts";
import { loadPackRules, publicResolution, resolvePacks } from "../src/corpus/packs.ts";
import { runCli } from "./helpers/run-cli.ts";

const FIXTURES = resolve(import.meta.dir, "fixtures");
const CORPUS = join(FIXTURES, "corpus");

const RULE = (title: string) =>
  `---\ntitle: "${title}"\napplies_when:\n  - "Always"\n---\n\n# ${title}\n`;

function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "compound-cli-packs-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function resolveIn(root: string, env: Record<string, string> = {}) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "compound-cli-cache-"));
  const git = createGitCache({ ...process.env, CE_PACKS_CACHE_ROOT: cacheRoot, ...env });
  return { resolution: resolvePacks(loadCeConfig(root), git), git, cacheRoot };
}

describe("resolvePacks with path sources", () => {
  test("a repo-relative source with rules publishes itself and excludes the README", () => {
    const { resolution } = resolveIn(CORPUS);
    expect(resolution.errors).toEqual([]);
    expect(resolution.roots.map((r) => r.id)).toEqual(["local-rules"]);
    expect(resolution.roots[0]?.nested_rule_shaped).toBe(1);
    const rules = loadPackRules(resolution.roots);
    expect(rules.candidates.map((c) => c.packPath).sort()).toEqual([
      "prefer-small-prs.md",
      "reviewer-skip-tests.md",
    ]);
    expect(
      rules.candidates.every((c) => c.kind === "pack_rule" && c.packId === "local-rules"),
    ).toBe(true);
    expect(rules.candidates[0]?.path).toMatch(/^local-rules\//);
  });

  test("a rule without applies_when is skipped with a warning naming pack/file", () => {
    const { resolution } = resolveIn(CORPUS);
    expect(resolution.warnings.join("\n")).toContain("skipped pack file `local-rules/notes.md`");
  });

  test("a source directory of packs publishes each child with rules", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "packs:\n  - source: packs\n",
      "packs/alpha/one.md": RULE("One"),
      "packs/beta/two.md": RULE("Two"),
      "packs/gamma/README.md": RULE("Only a readme"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots.map((r) => r.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("pack selection and id override", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml":
        "packs:\n  - source: packs\n    pack: alpha\n    id: renamed\n  - source: packs\n    pack: [nope]\n",
      "packs/alpha/one.md": RULE("One"),
      "packs/beta/two.md": RULE("Two"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots.map((r) => r.id)).toEqual(["renamed"]);
    expect(resolution.errors[0]).toContain("pack id(s) nope not published");
    expect(resolution.errors[0]).toContain("available: alpha, beta");
  });

  test("a path source rejects ref and path keys", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml":
        "packs:\n  - source: packs\n    ref: main\n  - source: packs\n    path: sub\n",
      "packs/alpha/one.md": RULE("One"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots).toEqual([]);
    expect(resolution.errors[0]).toContain("`ref:` is only valid on git sources");
    expect(resolution.errors[1]).toContain("`path:` is only valid on git sources");
  });

  test("a git source without ref is an error; tree URL sugar parses and conflicts are errors", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": [
        "packs:",
        "  - source: https://github.com/o/r.git",
        "  - source: https://github.com/o/r/tree/v1/packs",
        "    ref: v2",
        "  - source: https://github.com/o/r/tree/v1/packs",
        "    path: other",
        "",
      ].join("\n"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.errors[0]).toContain("requires `ref:`");
    expect(resolution.errors[1]).toContain("tree URL pins ref `v1` but entry says `ref: v2`");
    expect(resolution.errors[2]).toContain("tree URL path `packs` conflicts with `path: other`");
  });

  test("duplicate ids keep the first declaration and record an error", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "packs:\n  - source: a/alpha\n",
      ".compound-engineering/config.local.yaml": "packs:\n  - source: b/alpha\n",
      "a/alpha/one.md": RULE("One"),
      "b/alpha/two.md": RULE("Two"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots).toHaveLength(1);
    expect(resolution.roots[0]?.dir).toContain(join("a", "alpha"));
    expect(resolution.errors[0]).toMatch(
      /duplicate pack id `alpha`: config\.local\.yaml:\d+ ignored/,
    );
  });

  test("a pack with rules only in a subfolder publishes nothing and explains why", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "packs:\n  - source: packs\n",
      "packs/deep/rules/one.md": RULE("One"),
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots).toEqual([]);
    expect(resolution.warnings[0]).toContain("publishes no packs");
    expect(resolution.warnings[1]).toContain(
      "pack `deep` has 1 rule-shaped file(s) under `rules/`",
    );
  });

  test("a symlink pointing outside the source refuses the pack", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "packs:\n  - source: packs/alpha\n",
      "packs/alpha/one.md": RULE("One"),
    });
    const outside = mkdtempSync(join(tmpdir(), "compound-cli-outside-"));
    writeFileSync(join(outside, "secret.md"), RULE("Secret"));
    symlinkSync(join(outside, "secret.md"), join(root, "packs/alpha/link.md"));
    const { resolution } = resolveIn(root);
    expect(resolution.roots).toEqual([]);
    expect(resolution.errors[0]).toContain("pack `alpha` not published");
    expect(resolution.errors[0]).toContain("`link.md`");
  });

  test("a repo-relative source outside the repository is refused", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": "packs:\n  - source: ../elsewhere\n",
    });
    mkdirSync(join(root, "..", "elsewhere"), { recursive: true });
    const { resolution } = resolveIn(root);
    expect(resolution.errors[0]).toMatch(/resolves outside the repository/);
  });
});

describe("resolvePacks with a git source", () => {
  let remote: string;

  beforeAll(() => {
    const work = mkdtempSync(join(tmpdir(), "compound-cli-remote-"));
    mkdirSync(join(work, "packs/gitpack"), { recursive: true });
    writeFileSync(join(work, "packs/gitpack/rule.md"), RULE("From git"));
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: work,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    git("init", "--quiet", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "init");
    git("tag", "v1");
    remote = `file://${work}`;
  });

  test("clones into the shared cache key and reuses the clone", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": `packs:\n  - source: ${remote}\n    ref: v1\n    path: packs\n`,
    });
    const { resolution, cacheRoot } = resolveIn(root);
    expect(resolution.errors).toEqual([]);
    expect(resolution.roots.map((r) => r.id)).toEqual(["gitpack"]);
    expect(resolution.roots[0]?.dir).toBe(
      join(cacheRoot, cacheKey(remote, "v1"), "packs", "gitpack"),
    );
    expect(resolution.roots[0]?.url).toBe(remote);
    const again = resolvePacks(
      loadCeConfig(root),
      createGitCache({ ...process.env, CE_PACKS_CACHE_ROOT: cacheRoot }),
    );
    expect(again.warnings).toEqual([]);
    expect(again.roots[0]?.dir).toBe(resolution.roots[0]?.dir);
  });

  test("an unreachable ref warns and skips rather than failing the run", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": `packs:\n  - source: ${remote}\n    ref: does-not-exist\n`,
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots).toEqual([]);
    expect(resolution.warnings[0]).toContain("cannot fetch `does-not-exist`");
  });

  test("a single-pack git source is named after its last path segment", () => {
    const root = tempRepo({
      ".compound-engineering/config.yaml": `packs:\n  - source: ${remote}\n    ref: v1\n    path: packs/gitpack\n`,
    });
    const { resolution } = resolveIn(root);
    expect(resolution.roots.map((r) => r.id)).toEqual(["gitpack"]);
  });
});

describe("packs commands", () => {
  test("packs resolve prints the packs-resolve.py JSON shape", async () => {
    const result = await runCli(["packs", "resolve", "--root", CORPUS]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Object.keys(json).sort()).toEqual(["entries", "errors", "roots", "warnings"]);
    expect(json.roots[0]).toEqual({
      id: "local-rules",
      dir: expect.stringContaining("local-rules"),
      nested_rule_shaped: 1,
    });
    expect(json.entries).toBe(1);
  });

  test("packs list --json lists rules with applies_when", async () => {
    const result = await runCli(["packs", "list", "--json", "--root", CORPUS]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.packs[0].id).toBe("local-rules");
    expect(json.packs[0].rules.map((r: { path: string }) => r.path).sort()).toEqual([
      "prefer-small-prs.md",
      "reviewer-skip-tests.md",
    ]);
  });

  test("publicResolution strips internal labels", () => {
    const { resolution } = resolveIn(CORPUS);
    expect(JSON.stringify(publicResolution(resolution))).not.toContain("label");
  });
});
