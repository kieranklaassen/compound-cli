import { readFileSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { walkMarkdown } from "../corpus/learnings.ts";
import type { Workspace } from "../corpus/load.ts";
import { containedMdFiles, resolvePacks } from "../corpus/packs.ts";
import { errorMessage } from "../util.ts";
import { type SplitDocument, splitDocument } from "./document.ts";
import type { FileAudit } from "./report.ts";
import { type DocumentKind, runRules } from "./rules.ts";
import { buildVocabulary, type Vocabulary } from "./vocabulary.ts";

/** One file the audit read: where it is, what kind it is, and its split text. */
export type AuditedFile = {
  path: string;
  absPath: string;
  kind: DocumentKind;
  doc: SplitDocument;
  /** Pack rules live in the shared cache and are never written. */
  writable: boolean;
};

export type AuditCorpus = {
  files: AuditedFile[];
  vocabulary: Vocabulary;
  /** True when docs/solutions exists (even if empty). */
  hasSolutions: boolean;
  warnings: string[];
};

/** Read every learning (and, when asked, every declared pack rule) with the same boundary rules as find. */
export function loadAuditCorpus(workspace: Workspace, options: { packs: boolean }): AuditCorpus {
  const files: AuditedFile[] = [];
  const warnings: string[] = [];
  const solutionsDir = join(workspace.config.docsRootAbs, "solutions");
  let hasSolutions = false;
  try {
    const repoReal = realpathSync(workspace.repoRoot);
    const real = realpathSync(solutionsDir);
    hasSolutions = true;
    if (real === repoReal || real.startsWith(`${repoReal}/`)) {
      for (const absPath of walkMarkdown(solutionsDir)) {
        const file = read(
          absPath,
          relative(workspace.repoRoot, absPath),
          "solution",
          true,
          warnings,
        );
        if (file) files.push(file);
      }
    } else {
      warnings.push(
        `skipped ${relative(workspace.repoRoot, solutionsDir)}: resolves outside the repository`,
      );
    }
  } catch {
    hasSolutions = false;
  }
  if (options.packs) {
    const resolution = resolvePacks(workspace.config, workspace.git);
    warnings.push(...resolution.warnings, ...resolution.errors);
    for (const root of resolution.roots) {
      for (const absPath of containedMdFiles(root.dir, root.boundary, [])) {
        if (basename(absPath).toLowerCase() === "readme.md") continue;
        const file = read(absPath, `${root.id}/${basename(absPath)}`, "pack_rule", false, warnings);
        if (file) files.push(file);
      }
    }
  }
  return {
    files,
    vocabulary: buildVocabulary(files.filter((f) => f.kind === "solution").map((f) => f.doc)),
    hasSolutions,
    warnings,
  };
}

function read(
  absPath: string,
  path: string,
  kind: DocumentKind,
  writable: boolean,
  warnings: string[],
): AuditedFile | undefined {
  try {
    return { path, absPath, kind, doc: splitDocument(readFileSync(absPath, "utf8")), writable };
  } catch (error) {
    warnings.push(`skipped ${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Rules only, no judge: what doctor and the report-only audit share. */
export function auditFiles(files: AuditedFile[]): FileAudit[] {
  return files.map((file) => ({
    path: file.path,
    kind: file.kind,
    findings: runRules(file.doc, { path: file.path, kind: file.kind }),
  }));
}
