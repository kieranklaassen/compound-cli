import type { UsageReport } from "../judge/usage.ts";
import type { NeedsAuthor } from "./fixers/jev.ts";
import type { DocumentKind, Finding } from "./rules.ts";
import type { FieldChange } from "./writer.ts";

export type FileAudit = {
  path: string;
  kind: DocumentKind;
  findings: Finding[];
  /** Set by --fix: what changed, what could not, and the diff of the frontmatter block. */
  fix?: FileFix;
};

export type FileFix = {
  changes: FieldChange[];
  needs_author: NeedsAuthor[];
  diff: string;
  written: boolean;
  /** Findings that remain after the fix, re-run on the new text. */
  remaining: Finding[];
};

export type AuditSummary = {
  files: number;
  passing: number;
  errors: number;
  warnings: number;
  fixable: number;
  files_failing: number;
  fixes_applied: number;
  fixes_proposed: number;
  needs_author: number;
};

export type AuditReport = {
  schema_version: 1;
  strict: boolean;
  fix: "off" | "dry-run" | "applied" | "declined";
  summary: AuditSummary;
  files: FileAudit[];
  usage: UsageReport | null;
  warnings: string[];
};

export function failing(file: FileAudit, strict: boolean): boolean {
  const findings = file.fix ? file.fix.remaining : file.findings;
  return findings.some((f) => f.severity === "error" || (strict && f.severity === "warning"));
}

export function summarize(files: FileAudit[], strict: boolean): AuditSummary {
  let errors = 0;
  let warnings = 0;
  let fixable = 0;
  let applied = 0;
  let proposed = 0;
  let needsAuthor = 0;
  let filesFailing = 0;
  for (const file of files) {
    const findings = file.fix ? file.fix.remaining : file.findings;
    for (const f of findings) {
      if (f.severity === "error") errors++;
      else warnings++;
      if (f.fixable) fixable++;
    }
    if (failing(file, strict)) filesFailing++;
    if (file.fix) {
      if (file.fix.written) applied += file.fix.changes.length;
      else proposed += file.fix.changes.length;
      needsAuthor += file.fix.needs_author.length;
    }
  }
  return {
    files: files.length,
    passing: files.length - filesFailing,
    errors,
    warnings,
    fixable,
    files_failing: filesFailing,
    fixes_applied: applied,
    fixes_proposed: proposed,
    needs_author: needsAuthor,
  };
}

export function renderText(report: AuditReport): string {
  const lines: string[] = [];
  for (const file of report.files) {
    const findings = file.fix ? file.fix.remaining : file.findings;
    if (!findings.length && !file.fix) continue;
    if (!findings.length && file.fix && !file.fix.changes.length && !file.fix.needs_author.length)
      continue;
    lines.push(file.path);
    for (const f of findings) {
      lines.push(
        `  ${f.severity.padEnd(7)} ${f.rule.padEnd(28)} ${f.message}${f.fixable ? "" : "  (needs a hand)"}`,
      );
    }
    if (file.fix) {
      if (file.fix.diff) lines.push(indent(file.fix.diff.trimEnd(), "  "));
      for (const change of file.fix.changes) {
        const score = change.score === undefined ? "" : ` at ${change.score}`;
        lines.push(
          `  ${file.fix.written ? "fixed" : "would fix"} ${change.field} (${change.source}${score}: ${change.note})`,
        );
      }
      for (const need of file.fix.needs_author) {
        lines.push(`  needs_author ${need.field}: ${need.reason}`);
      }
    }
    lines.push("");
  }
  const s = report.summary;
  const parts = [
    `${s.files} file${s.files === 1 ? "" : "s"}`,
    `${s.passing} passing`,
    `${s.errors} error${s.errors === 1 ? "" : "s"}`,
    `${s.warnings} warning${s.warnings === 1 ? "" : "s"}`,
  ];
  if (report.fix === "off") parts.push(`${s.fixable} fixable`);
  else {
    parts.push(
      report.fix === "applied"
        ? `${s.fixes_applied} fixes applied`
        : `${s.fixes_proposed} fixes ${report.fix === "dry-run" ? "proposed (dry run)" : "declined"}`,
    );
    parts.push(`${s.needs_author} needs_author`);
  }
  if (report.strict) parts.push("strict");
  lines.push(`compound audit: ${parts.join(", ")}`);
  if (report.usage && report.usage.requests > 0) {
    lines.push(
      `usage: ${report.usage.requests} requests, ${report.usage.input_tokens.toLocaleString("en-US")} input tokens, $${report.usage.estimated_usd.toFixed(5)}, model ${report.usage.model ?? "n/a"}`,
    );
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
