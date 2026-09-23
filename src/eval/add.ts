import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import { UsageError } from "../errors.ts";
import { safeId } from "./import.ts";

/**
 * Harvest a real miss as a case: the work context that was in hand, the
 * repository and its commit at that moment, the learning that should have
 * surfaced, and one line on what happened instead. The case is a pointer plus
 * an expectation; no plan or learning text is copied.
 */

export type MissInput = {
  id: string;
  activity?: string;
  concepts: string[];
  decisions: string[];
  domains: string[];
  modules: string[];
  paths: string[];
  /** A plan inside the repository, made repo-relative. */
  plan?: string;
  redactCitations: boolean;
  /** What should have surfaced. */
  hits: string[];
  packs: string[];
  nearMiss: string[];
  note: string;
  tags: string[];
  /** The repository the miss happened in; its origin URL and HEAD become the case's corpus pin. */
  repoRoot: string;
  docsRoot: string;
  /** Override the pin (a checkout with no remote, or a fork). */
  corpusGit?: string;
  corpusRef?: string;
};

export type MissCase = { dir: string; corpus: { git: string; ref: string; docs_root?: string } };

export function writeMissCase(input: MissInput, outDir: string): MissCase {
  if (!input.hits.length && !input.packs.length) {
    throw new UsageError(
      "a miss names what should have surfaced: --expect <path> or --expect-pack <id>",
    );
  }
  if (!input.note.trim())
    throw new UsageError("a miss needs --note: one line on what happened instead");
  const git = input.corpusGit ?? originUrl(input.repoRoot);
  const ref = input.corpusRef ?? headSha(input.repoRoot);
  if (!git) {
    throw new UsageError(
      `${input.repoRoot} has no origin remote; pass --corpus-git <url> so the case can pin the repository`,
    );
  }
  if (!ref)
    throw new UsageError(`${input.repoRoot} is not a git checkout; pass --corpus-ref <sha>`);
  for (const path of input.hits) {
    // A learning is repo-relative, a pack rule is `<pack-id>/<file>`; both carry a slash.
    if (!path.includes("/")) {
      throw new UsageError(
        `--expect ${path}: a learning is a repo-relative path, a pack rule <pack-id>/<file>`,
      );
    }
  }
  const id = safeId(input.id);
  if (!id) throw new UsageError(`"${input.id}" leaves nothing usable as a case id`);
  const dir = join(outDir, id);
  if (existsSync(dir)) throw new UsageError(`${dir} exists; pick another --id`);

  const corpus: MissCase["corpus"] = { git, ref };
  if (input.docsRoot !== "docs") corpus.docs_root = input.docsRoot;
  const fm: Record<string, unknown> = {
    tags: [...new Set(["miss", ...input.tags])],
    note: input.note.trim(),
    corpus,
  };
  if (input.plan !== undefined) {
    const abs = resolve(input.repoRoot, input.plan);
    if (!existsSync(abs))
      throw new UsageError(`--plan ${input.plan}: not found in ${input.repoRoot}`);
    const rel = relative(input.repoRoot, abs);
    if (rel.startsWith("..")) throw new UsageError(`--plan ${input.plan}: outside the repository`);
    fm.plan = rel;
    if (input.redactCitations) fm.redact_citations = true;
  }
  for (const key of ["concepts", "decisions", "domains", "modules", "paths"] as const) {
    if (input[key].length) fm[key] = input[key];
  }
  const expect: Record<string, unknown> = {};
  if (input.hits.length) expect.hits = input.hits;
  if (input.packs.length) expect.packs = input.packs;
  if (input.nearMiss.length) expect.near_miss = input.nearMiss;

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "query.md"),
    `---\n${stringify(fm)}---\n${input.activity ? `${input.activity.trim()}\n` : ""}`,
  );
  writeFileSync(join(dir, "expect.yaml"), stringify(expect));
  return { dir, corpus };
}

function gitOutput(repoRoot: string, args: string[]): string | undefined {
  const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", timeout: 5000 });
  if (run.status !== 0) return undefined;
  const out = run.stdout.trim();
  return out || undefined;
}

export function originUrl(repoRoot: string): string | undefined {
  const url = gitOutput(repoRoot, ["remote", "get-url", "origin"]);
  // A token or user in the URL never reaches a case file.
  return url?.replace(/^(https?:\/\/)[^@/]+@/, "$1");
}

export function headSha(repoRoot: string): string | undefined {
  return gitOutput(repoRoot, ["rev-parse", "HEAD"]);
}
