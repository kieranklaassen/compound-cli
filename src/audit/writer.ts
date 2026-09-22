import { parseDocument } from "yaml";
import type { SplitDocument } from "./document.ts";

/** One field change a fixer proposes. `value: undefined` removes the field (unused today). */
export type FieldChange = {
  field: string;
  value: unknown;
  source: "deterministic" | "jev";
  /** Jev's score for the winning answer, when there was one. */
  score?: number;
  note: string;
};

export type RewriteResult = {
  text: string;
  frontmatterText: string;
};

/**
 * Apply field changes to the frontmatter block through yaml's Document API so
 * untouched keys, their order, and comments survive; reassemble the file with
 * the original body bytes, delimiter style, and line endings.
 */
export function rewriteFrontmatter(doc: SplitDocument, changes: FieldChange[]): RewriteResult {
  // An empty block parses to a null document; start from an empty mapping instead.
  const yamlDoc = parseDocument(doc.frontmatterText.trim() ? doc.frontmatterText : "{}");
  for (const change of changes) {
    if (change.value === undefined) {
      yamlDoc.delete(change.field);
      continue;
    }
    yamlDoc.set(change.field, change.value);
    // A value cut at " #" left its tail as a comment on the node; the new value carries it.
    const node = yamlDoc.get(change.field, true);
    if (node && typeof node === "object" && "comment" in node) node.comment = null;
  }
  // A block that started empty parsed as a flow mapping; frontmatter is block style.
  if (yamlDoc.contents && typeof yamlDoc.contents === "object" && "flow" in yamlDoc.contents) {
    (yamlDoc.contents as { flow?: boolean }).flow = false;
  }
  let frontmatterText = yamlDoc
    .toString({ lineWidth: 0, flowCollectionPadding: false })
    .replace(/\n$/, "");
  if (frontmatterText === "{}") frontmatterText = "";
  if (doc.eol === "\r\n") frontmatterText = frontmatterText.replace(/\n/g, "\r\n");
  const text = `${doc.bom}---${doc.eol}${frontmatterText}${doc.eol}---${doc.eol}${doc.body}`;
  return { text, frontmatterText };
}

/** A unified diff of two texts, for the frontmatter block only, with the path as the header. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const ops = diffLines(a, b);
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]?.kind === "same") {
      i++;
      continue;
    }
    const start = Math.max(0, i - 3);
    let end = i;
    while (end < ops.length) {
      if (ops[end]?.kind !== "same") {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]?.kind === "same") run++;
      if (run > 6 || end + run >= ops.length) {
        end = Math.min(ops.length, end + 3);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = (hunk[0]?.aIndex ?? 0) + 1;
    const bStart = (hunk[0]?.bIndex ?? 0) + 1;
    const aCount = hunk.filter((o) => o.kind !== "add").length;
    const bCount = hunk.filter((o) => o.kind !== "remove").length;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const op of hunk) {
      out.push(`${op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " "}${op.line}`);
    }
    i = end;
  }
  return out.length > 2 ? `${out.join("\n")}\n` : "";
}

type Op = { kind: "same" | "add" | "remove"; line: string; aIndex: number; bIndex: number };

/** Longest-common-subsequence line diff; frontmatter blocks are small. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as number[];
    const next = lcs[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: "same", line: a[i] as string, aIndex: i, bIndex: j });
      i++;
      j++;
    } else if (i < n && (j >= m || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      // Removals before additions, as unified diffs read.
      ops.push({ kind: "remove", line: a[i] as string, aIndex: i, bIndex: j });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] as string, aIndex: i, bIndex: j });
      j++;
    }
  }
  return ops;
}
