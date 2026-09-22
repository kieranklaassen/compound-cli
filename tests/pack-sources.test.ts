import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendPackEntry, renderEntry } from "../src/commands/packs-add.ts";
import { loadCeConfig } from "../src/config/ce-config.ts";
import type { Context } from "../src/context.ts";
import { createGitCache } from "../src/corpus/git-cache.ts";
import type { Workspace } from "../src/corpus/load.ts";
import {
  EVERY_SOURCE,
  HOME_SOURCE,
  knownSources,
  loadPackCandidates,
} from "../src/corpus/pack-sources.ts";
import { DEFAULTS } from "../src/find/defaults.ts";
import { NO_FILTERS } from "../src/find/filters.ts";
import { runFind } from "../src/find/find.ts";
import { repoProfile } from "../src/input/repo-profile.ts";
import { buildWorkState } from "../src/input/work-state.ts";
import { suggestRequest } from "../src/judge/questions.ts";
import { runCli } from "./helpers/run-cli.ts";
import { testJudge } from "./helpers/test-judge.ts";

const CORPUS = resolve(import.meta.dir, "fixtures/corpus");
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "compound-cli-home-"));

const ctx: Context = {
  cwd: CORPUS,
  env: {},
  stdout: () => {},
  stderr: () => {},
  readStdin: async () => "",
  isTTY: false,
};

describe("knownSources", () => {
  test("lists the built-ins then pack_sources, and omits ~/compound-packs when absent", () => {
    const sources = knownSources(loadCeConfig(CORPUS), { HOME: EMPTY_HOME });
    expect(sources.map((s) => s.source)).toEqual([EVERY_SOURCE, "packs"]);
    expect(sources[0]).toMatchObject({ kind: "git", ref: "main", path: "packs" });
    expect(sources[1]).toMatchObject({
      kind: "local",
      label: expect.stringMatching(/config\.local\.yaml:\d+/),
    });
  });

  test("includes ~/compound-packs/packs when the directory exists", () => {
    const home = mkdtempSync(join(tmpdir(), "compound-cli-home-"));
    cpSync(join(CORPUS, "packs"), join(home, "compound-packs", "packs"), { recursive: true });
    const sources = knownSources(loadCeConfig(CORPUS), { HOME: home });
    expect(sources[0]?.source).toBe(HOME_SOURCE);
  });
});

describe("loadPackCandidates", () => {
  test("yields the undeclared packs of a local source with the entry that would declare them", () => {
    const config = loadCeConfig(CORPUS);
    const load = loadPackCandidates(
      config,
      new Set(["local-rules"]),
      { HOME: EMPTY_HOME },
      "cached-only",
    );
    expect(load.candidates.map((c) => c.packId)).toEqual(["second-pack"]);
    const candidate = load.candidates[0];
    expect(candidate?.kind).toBe("pack_candidate");
    expect(candidate?.path).toBe("second-pack/README.md");
    expect(candidate?.appliesWhen).toHaveLength(2);
    expect(candidate?.declaration).toEqual({ source: "packs", pack: "second-pack" });
    expect(load.warnings.join("\n")).toContain("not cached");
  });

  test("a declared pack is not a candidate and a home source wins over a git source for the same id", () => {
    const home = mkdtempSync(join(tmpdir(), "compound-cli-home-"));
    cpSync(join(CORPUS, "packs"), join(home, "compound-packs", "packs"), { recursive: true });
    const load = loadPackCandidates(
      loadCeConfig(CORPUS),
      new Set(["local-rules", "second-pack"]),
      { HOME: home },
      "cached-only",
    );
    expect(load.candidates).toEqual([]);
    const again = loadPackCandidates(
      loadCeConfig(CORPUS),
      new Set(["local-rules"]),
      { HOME: home },
      "cached-only",
    );
    expect(again.candidates.map((c) => c.declaration)).toEqual([
      { source: HOME_SOURCE, pack: "second-pack" },
    ]);
  });
});

describe("find with known sources", () => {
  test("an undeclared pack whose README matches the work is a pack_candidate hit with its declaration", async () => {
    const workspace: Workspace = {
      repoRoot: CORPUS,
      config: loadCeConfig(CORPUS),
      git: createGitCache({}),
    };
    const run = await runFind({
      workspace,
      state: await buildWorkState(
        {
          activity:
            "Decide whether to cancel a customer's separate add-on subscription now that the new bundle covers it",
          concepts: [],
          decisions: [],
          domains: [],
          modules: [],
          paths: [],
          diffPath: undefined,
          planPath: undefined,
          docPath: undefined,
        },
        ctx,
      ),
      judge: testJudge("find/pack-candidate"),
      settings: {
        threshold: DEFAULTS.threshold,
        tierOneThreshold: DEFAULTS.tierOneThreshold,
        frontmatterOnly: false,
        batch: DEFAULTS.batch,
        parallel: 4,
        candidateCap: DEFAULTS.candidateCap,
        excerptChars: DEFAULTS.excerptChars,
        model: DEFAULTS.model,
      },
      filters: NO_FILTERS,
      mode: "find",
      loadPackCandidates: (ws, declared) =>
        loadPackCandidates(ws.config, declared, { HOME: EMPTY_HOME }, "cached-only"),
    });
    const pack = run.result.hits.find((h) => h.kind === "pack_candidate");
    expect(pack?.pack_id).toBe("second-pack");
    expect(pack?.declaration).toEqual({ source: "packs", pack: "second-pack" });
    expect(pack?.passage).toBeNull();
    expect(run.result.corpus.pack_candidates).toBe(1);
  });
});

describe("repo profile and suggest request", () => {
  test("the profile carries the repository name, top-level directories, and declared packs", () => {
    const profile = repoProfile(CORPUS, ["local-rules"]);
    expect(profile.repository).toBe("corpus");
    expect(profile.top_level).toEqual(["docs/", "packs/"]);
    expect(profile.declared_packs).toEqual(["local-rules"]);
    expect(profile.manifests).toEqual([]);
  });

  test("suggest asks the adopt question with the profile as work", () => {
    const load = loadPackCandidates(
      loadCeConfig(CORPUS),
      new Set(["local-rules"]),
      { HOME: EMPTY_HOME },
      "cached-only",
    );
    const request = suggestRequest(
      { repository: repoProfile(CORPUS, ["local-rules"]) },
      load.candidates,
    );
    expect(JSON.stringify(request.state)).toContain('"repository":"corpus"');
    expect(String(request.questions.c000?.instructions)).toContain("Should the pack tagged c000");
    expect(request.state.task).toContain("Compound Packs");
  });
});

describe("packs add", () => {
  function tempConfig(content: string | null): { root: string; path: string } {
    const root = mkdtempSync(join(tmpdir(), "compound-cli-add-"));
    const path = join(root, ".compound-engineering", "config.yaml");
    if (content !== null) {
      cpSync(join(CORPUS, ".compound-engineering"), join(root, ".compound-engineering"), {
        recursive: true,
      });
      writeFileSync(path, content);
    }
    return { root, path };
  }

  test("appends after the last item of an existing packs block and leaves other keys alone", () => {
    const { path } = tempConfig(
      "# team config\ndocs_root: docs\npacks:\n  - source: packs/local-rules\n\nother: value\n",
    );
    const entry = renderEntry({ source: "packs", pack: "second-pack" });
    expect(appendPackEntry(path, entry)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      "# team config\ndocs_root: docs\npacks:\n  - source: packs/local-rules\n  - source: packs\n    pack: second-pack\n\nother: value\n",
    );
    expect(appendPackEntry(path, entry)).toBe(false);
    expect(loadCeConfig(join(path, "..", "..")).packs).toHaveLength(2);
  });

  test("adds a packs key when the file has none, and creates the file when absent", () => {
    const withoutPacks = tempConfig("docs_root: docs\n");
    appendPackEntry(
      withoutPacks.path,
      renderEntry({ source: "~/compound-packs/packs", pack: "kieran-engineering" }),
    );
    expect(readFileSync(withoutPacks.path, "utf8")).toBe(
      "docs_root: docs\n\npacks:\n  - source: ~/compound-packs/packs\n    pack: kieran-engineering\n",
    );
    const absent = tempConfig(null);
    appendPackEntry(
      absent.path,
      renderEntry({ source: "https://github.com/o/r.git", ref: "v1", path: "packs", pack: "x" }),
    );
    expect(readFileSync(absent.path, "utf8")).toBe(
      "packs:\n  - source: https://github.com/o/r.git\n    ref: v1\n    path: packs\n    pack: x\n",
    );
  });

  test("matches the indentation of existing items", () => {
    const { path } = tempConfig("packs:\n- source: a/b\n");
    appendPackEntry(path, renderEntry({ source: "packs", pack: "second-pack" }));
    expect(readFileSync(path, "utf8")).toBe(
      "packs:\n- source: a/b\n- source: packs\n  pack: second-pack\n",
    );
  });

  test("the CLI writes with --yes, refuses without a TTY, and names known ids for an unknown pack", async () => {
    const { root, path } = tempConfig("docs_root: docs\npacks:\n  - source: packs/local-rules\n");
    cpSync(join(CORPUS, "packs"), join(root, "packs"), { recursive: true });
    cpSync(
      join(CORPUS, ".compound-engineering", "config.local.yaml"),
      join(root, ".compound-engineering", "config.local.yaml"),
    );
    const env = {
      HOME: EMPTY_HOME,
      CE_PACKS_CACHE_ROOT: mkdtempSync(join(tmpdir(), "compound-cli-cache-")),
      CE_PACKS_GIT_TIMEOUT: "5",
    };

    const refused = await runCli(["packs", "add", "second-pack", "--root", root], { env });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");

    const unknown = await runCli(["packs", "add", "nope", "--yes", "--root", root], { env });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("second-pack");

    const written = await runCli(["packs", "add", "second-pack", "--yes", "--root", root], { env });
    expect(written.code).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("  - source: packs\n    pack: second-pack\n");

    const again = await runCli(["packs", "add", "second-pack", "--yes", "--root", root], { env });
    expect(again.stdout).toContain("already declared");
  }, 60_000);
});
