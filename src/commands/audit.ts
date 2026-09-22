import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HELP_OPTION, type OptionSpecs, parseCommandArgs, ROOT_OPTION } from "../args.ts";
import { type AuditedFile, auditFiles, loadAuditCorpus } from "../audit/audit.ts";
import { splitDocument } from "../audit/document.ts";
import { deterministicFixes } from "../audit/fixers/deterministic.ts";
import { jevFixes, type NeedsAuthor, THRESHOLDS } from "../audit/fixers/jev.ts";
import {
  type AuditReport,
  type FileAudit,
  type FileFix,
  failing,
  renderText,
  summarize,
} from "../audit/report.ts";
import { runRules } from "../audit/rules.ts";
import type { Vocabulary } from "../audit/vocabulary.ts";
import { type FieldChange, rewriteFrontmatter, unifiedDiff } from "../audit/writer.ts";
import type { Context } from "../context.ts";
import { openWorkspace } from "../corpus/load.ts";
import { MissingCorpusError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { AUDIT_HELP } from "../help.ts";
import { type Judge, judgeFromEnv } from "../judge/client.ts";

const AUDIT_OPTIONS = {
  ...HELP_OPTION,
  ...ROOT_OPTION,
  json: { type: "boolean" },
  strict: { type: "boolean" },
  packs: { type: "boolean" },
  report: { type: "string" },
  fix: { type: "boolean" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean" },
  model: { type: "string" },
} as const satisfies OptionSpecs;

export async function run(argv: string[], ctx: Context): Promise<number> {
  const parsed = parseCommandArgs(argv, AUDIT_OPTIONS);
  const v = parsed.values;
  if (v.help) {
    ctx.stdout(AUDIT_HELP);
    return EXIT.OK;
  }
  if (parsed.positionals.length) {
    throw new UsageError(
      `audit takes no file arguments (got ${parsed.positionals.join(" ")}); it walks <root>/solutions, use --root to choose the repository`,
    );
  }
  if ((v["dry-run"] || v.yes) && !v.fix) {
    throw new UsageError("--dry-run and --yes only apply with --fix");
  }
  const fixing = Boolean(v.fix);
  // The key check comes before any file is read (plan R28): --fix without a key is exit 3.
  const judge = fixing
    ? judgeFromEnv(ctx.env, v.model === undefined ? {} : { model: v.model })
    : null;
  if (fixing && !v["dry-run"] && !v.yes && !ctx.isTTY) {
    throw new UsageError(
      "--fix writes files; pass --yes to apply without a prompt, or --dry-run to only show the diffs",
    );
  }

  const workspace = openWorkspace(ctx.cwd, ctx.env, v.root);
  const corpus = loadAuditCorpus(workspace, { packs: Boolean(v.packs) });
  if (!corpus.hasSolutions && corpus.files.length === 0) {
    throw new MissingCorpusError(workspace.config.docsRoot);
  }

  let files = auditFiles(corpus.files);
  let mode: AuditReport["fix"] = "off";
  if (judge) {
    files = await proposeFixes(files, corpus.files, corpus.vocabulary, judge);
    if (v["dry-run"]) {
      mode = "dry-run";
    } else {
      const pending = files.filter((f) => f.fix && f.fix.changes.length > 0);
      const changeCount = pending.reduce((n, f) => n + (f.fix?.changes.length ?? 0), 0);
      let apply = Boolean(v.yes);
      if (!apply && pending.length) {
        for (const file of pending) if (file.fix?.diff) ctx.stderr(`${file.fix.diff}\n`);
        apply = await ctx.confirm(
          `Apply ${changeCount} fix${changeCount === 1 ? "" : "es"} to ${pending.length} file${pending.length === 1 ? "" : "s"}?`,
        );
      }
      if (apply) {
        for (const file of pending) {
          const source = corpus.files.find((f) => f.path === file.path);
          if (!source || !file.fix || !source.writable) continue;
          writeFileSync(source.absPath, rewriteFrontmatter(source.doc, file.fix.changes).text);
          file.fix.written = true;
        }
        mode = "applied";
      } else {
        mode = pending.length ? "declined" : "applied";
      }
    }
  }

  const report: AuditReport = {
    schema_version: 1,
    strict: Boolean(v.strict),
    fix: mode,
    thresholds: judge ? THRESHOLDS : null,
    summary: summarize(files, Boolean(v.strict), mode === "dry-run" || mode === "declined"),
    files,
    usage: judge ? judge.usage.snapshot() : null,
    warnings: corpus.warnings,
  };
  if (v.report) {
    const out = resolve(ctx.cwd, v.report);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (v.json) ctx.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else ctx.stdout(renderText(report));
  return files.some((f) => failing(f, Boolean(v.strict))) ? EXIT.FINDINGS : EXIT.OK;
}

/**
 * For every file with a fixable finding: deterministic fixes first, then Jev
 * for what remains, then the diff and the findings that would remain after
 * the rewrite. Nothing is written here.
 */
export async function proposeFixes(
  audits: FileAudit[],
  sources: AuditedFile[],
  vocabulary: Vocabulary,
  judge: Judge,
): Promise<FileAudit[]> {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const out: FileAudit[] = [];
  for (const audit of audits) {
    const source = byPath.get(audit.path);
    const fixable = audit.findings.filter((f) => f.fixable);
    if (
      !source ||
      !fixable.length ||
      !source.doc.hasFrontmatter ||
      source.doc.parseError ||
      source.doc.unterminated
    ) {
      out.push(audit);
      continue;
    }
    if (!source.writable) {
      out.push({
        ...audit,
        fix: {
          changes: [],
          needs_author: [
            {
              field: "*",
              reason: "pack rules live in the shared cache; fix them in the pack's own repository",
            },
          ],
          diff: "",
          written: false,
          remaining: audit.findings,
        },
      });
      continue;
    }
    const changes: FieldChange[] = deterministicFixes(source.doc, audit.findings, {
      absPath: source.absPath,
      path: source.path,
    });
    const needsAuthor: NeedsAuthor[] = [];
    // Re-run the rules on the deterministically fixed text; Jev only sees what is left
    // (a wrapped scalar can still be generic, a normalised enum needs no judge).
    // Two Jev rounds at most: the first may move a file onto the bug track, which
    // makes symptoms, root_cause, and resolution_type required.
    for (let round = 0; round < 2; round++) {
      const current = splitDocument(rewriteFrontmatter(source.doc, changes).text);
      const leftover = runRules(current, { path: source.path, kind: source.kind }).filter(
        (f) => f.fixable && !needsAuthor.some((n) => n.field === f.field),
      );
      if (!leftover.length) break;
      const jev = await jevFixes(judge, current, source.path, leftover, vocabulary);
      for (const change of jev.changes) {
        const index = changes.findIndex((c) => c.field === change.field);
        if (index >= 0) changes.splice(index, 1);
        changes.push(change);
      }
      needsAuthor.push(
        ...jev.needsAuthor.filter((n) => !needsAuthor.some((m) => m.field === n.field)),
      );
      if (!jev.changes.length) break;
    }
    // A change that restates the current value is not a change.
    const effective = changes.filter(
      (c) => JSON.stringify(c.value) !== JSON.stringify(source.doc.data[c.field]),
    );
    changes.splice(0, changes.length, ...effective);
    const rewritten = rewriteFrontmatter(source.doc, changes);
    const remaining = runRules(splitDocument(rewritten.text), {
      path: source.path,
      kind: source.kind,
    });
    // A fixable finding no fixer could settle is the author's, and the report says so.
    for (const f of remaining) {
      const field = f.field ?? "*";
      if (
        f.fixable &&
        !changes.some((c) => c.field === field) &&
        !needsAuthor.some((n) => n.field === field)
      ) {
        needsAuthor.push({ field, reason: `no fixer could supply a value (${f.rule})` });
      }
    }
    const fix: FileFix = {
      changes,
      needs_author: needsAuthor,
      diff: changes.length
        ? unifiedDiff(source.path, source.doc.frontmatterText, rewritten.frontmatterText)
        : "",
      written: false,
      remaining,
    };
    out.push({ ...audit, fix });
  }
  return out;
}
