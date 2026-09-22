/**
 * How close does `audit --fix --jev` get to hand-written frontmatter?
 *
 * The deterministic fixers alone cannot supply a stripped value (they normalise
 * what is there), so this measures the Jev fixers; the numbers it prints are
 * the "with Jev" column of the agreement table.
 *
 * For every file whose chosen fields are present and valid, strip those fields
 * from an in-memory copy, run the fixers (vocabulary built from every other
 * file, so a file never votes for its own value), and compare: exact match for
 * enum and vocabulary fields, Jaccard and precision for tags, and for
 * applies_when one Jev judgment per file on whether the proposed list and the
 * hand-written list describe the same situations. Prints one JSON object.
 *
 * Environment: TYPESAFE_API_KEY (or cassette replay). Options:
 *   --root <checkout>      corpus root (default .)
 *   --fields a,b,c         fields to strip (default problem_type,severity,module,component,tags,applies_when)
 *   --limit <n>            at most n files
 *   --jobs <n>             concurrent files (default 4)
 */
import { parseArgs } from "node:util";
import { noul } from "@typesafe-ai/sdk";
import { loadAuditCorpus, type AuditedFile, contextFor } from "../../src/audit/audit.ts";
import { splitDocument } from "../../src/audit/document.ts";
import { runRules } from "../../src/audit/rules.ts";
import { buildVocabulary } from "../../src/audit/vocabulary.ts";
import { type FieldChange, rewriteFrontmatter } from "../../src/audit/writer.ts";
import { proposeFixes } from "../../src/commands/audit.ts";
import { processContext } from "../../src/context.ts";
import { openWorkspace } from "../../src/corpus/load.ts";
import { judgeFromEnv, noulOf } from "../../src/judge/client.ts";
import { Semaphore } from "../../src/judge/semaphore.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: "." },
    fields: { type: "string", default: "problem_type,severity,module,component,tags,applies_when" },
    limit: { type: "string" },
    jobs: { type: "string", default: "4" },
  },
});
const fields = (values.fields ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const ctx = processContext();
const workspace = openWorkspace(ctx.cwd, ctx.env, values.root);
const corpus = loadAuditCorpus(workspace, { packs: false, packDirs: [] });
const judge = judgeFromEnv(ctx.env, {});

type Comparison = {
  path: string;
  exact: Record<string, boolean>;
  /** The hand-written value was among the choices offered (leave-one-out vocabulary). */
  reachable: Record<string, boolean>;
  original: Record<string, string>;
  proposed: Record<string, string>;
  tags?: { jaccard: number; precision: number; recall_reachable: number; proposed: number; original: number };
  applies_when?:
    | { score: number; item_precision: number; proposed: number; original: number }
    | { needs_author: string };
  needs_author: string[];
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function eligible(file: AuditedFile): boolean {
  if (file.doc.parseError || !file.doc.hasFrontmatter) return false;
  const findings = runRules(file.doc, contextFor(file, corpus.options));
  if (findings.some((f) => f.field !== null && fields.includes(f.field))) return false;
  return fields.every((f) => {
    const value = file.doc.data[f];
    return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.trim().length > 0;
  });
}

const candidates = corpus.files.filter(eligible).slice(0, values.limit ? Number(values.limit) : undefined);
const gate = new Semaphore(Number(values.jobs));
const comparisons: Comparison[] = [];

await Promise.all(
  candidates.map((file) =>
    gate.run(async () => {
      const others = corpus.files.filter((f) => f.path !== file.path).map((f) => f.doc);
      const vocabulary = buildVocabulary(others);
      const removals: FieldChange[] = fields.map((f) => ({ field: f, value: undefined, source: "deterministic", note: "" }));
      const stripped: AuditedFile = { ...file, doc: splitDocument(rewriteFrontmatter(file.doc, removals).text) };
      const [audit] = await proposeFixes(
        [{ path: stripped.path, kind: stripped.kind, findings: runRules(stripped.doc, contextFor(stripped, corpus.options)) }],
        { files: [stripped], vocabulary, options: corpus.options },
        judge,
      );
      const changes = new Map((audit?.fix?.changes ?? []).map((c) => [c.field, c.value]));
      const needsAuthor = (audit?.fix?.needs_author ?? []).map((n) => n.field);
      const comparison: Comparison = { path: file.path, exact: {}, reachable: {}, original: {}, proposed: {}, needs_author: needsAuthor };
      for (const f of fields) {
        if (f === "tags" || f === "applies_when") continue;
        const original = String(file.doc.data[f]);
        comparison.original[f] = original;
        comparison.proposed[f] = String(changes.get(f) ?? "");
        comparison.exact[f] = comparison.proposed[f] === original;
        const offered = (vocabulary as Record<string, string[] | undefined>)[f];
        comparison.reachable[f] = offered === undefined || offered.length < 2 ? true : offered.includes(original);
      }
      if (fields.includes("tags")) {
        const original = new Set(stringList(file.doc.data.tags).map((t) => t.toLowerCase()));
        const proposed = new Set(stringList(changes.get("tags")).map((t) => t.toLowerCase()));
        const shared = [...proposed].filter((t) => original.has(t)).length;
        const union = new Set([...original, ...proposed]).size;
        const reachable = [...original].filter((t) => vocabulary.tags.includes(t));
        comparison.tags = {
          jaccard: union ? shared / union : 0,
          precision: proposed.size ? shared / proposed.size : 0,
          recall_reachable: reachable.length ? reachable.filter((t) => proposed.has(t)).length / reachable.length : 1,
          proposed: proposed.size,
          original: original.size,
        };
      }
      if (fields.includes("applies_when")) {
        const original = stringList(file.doc.data.applies_when);
        const proposed = stringList(changes.get("applies_when"));
        if (!proposed.length) {
          comparison.applies_when = { needs_author: needsAuthor.includes("applies_when") ? "needs_author" : "no proposal" };
        } else {
          const items: Record<string, string> = {};
          proposed.forEach((text, index) => {
            items[`p${String(index).padStart(2, "0")}`] = text;
          });
          const questions: Record<string, ReturnType<typeof noul>> = {
            same: noul(
              "Do the situations under `proposed` describe the same circumstances as the situations under `original`, so that a person in one list's situation is in the other's too? Yes when the lists match in substance even if worded differently; no when either list names situations the other does not cover.",
            ),
          };
          for (const tag of Object.keys(items)) {
            questions[`covered.${tag}`] = noul(
              `Is the situation tagged ${tag} under \`proposed\` covered by some situation under \`original\`: would the author of \`original\` agree it belongs on their list?`,
            );
          }
          const answers = await judge.ask(
            {
              task: "Two lists each describe the situations in which someone should read one learning. `original` was written by hand; `proposed` was extracted from the body. Judge whether they describe the same situations, and whether each proposed item is covered by the original.",
              original,
              proposed: items,
            },
            questions,
          );
          const covered = Object.keys(items).map((tag) => noulOf(answers, `covered.${tag}`));
          comparison.applies_when = {
            score: noulOf(answers, "same"),
            item_precision: covered.filter((c) => c >= 0.6).length / covered.length,
            proposed: proposed.length,
            original: original.length,
          };
        }
      }
      comparisons.push(comparison);
      process.stderr.write(`${file.path}\n`);
    }),
  ),
);

const BUG = new Set(["build_error", "test_failure", "runtime_error", "performance_issue", "database_issue", "security_issue", "ui_bug", "integration_issue", "logic_error"]);
const exact: Record<string, Record<string, unknown>> = {};
for (const f of fields) {
  if (f === "tags" || f === "applies_when") continue;
  const rows = comparisons.filter((c) => f in c.exact);
  const agree = rows.filter((c) => c.exact[f]).length;
  const reachable = rows.filter((c) => c.reachable[f]);
  const counts = new Map<string, number>();
  for (const c of rows) counts.set(c.original[f] as string, (counts.get(c.original[f] as string) ?? 0) + 1);
  const majority = Math.max(0, ...counts.values());
  const confusion = new Map<string, number>();
  for (const c of rows) if (!c.exact[f]) confusion.set(`${c.original[f]} -> ${c.proposed[f] || "(needs_author)"}`, (confusion.get(`${c.original[f]} -> ${c.proposed[f] || "(needs_author)"}`) ?? 0) + 1);
  exact[f] = {
    n: rows.length,
    agree,
    rate: rows.length ? Number((agree / rows.length).toFixed(3)) : 0,
    majority_class_baseline: rows.length ? Number((majority / rows.length).toFixed(3)) : 0,
    reachable: reachable.length,
    rate_when_reachable: reachable.length ? Number((reachable.filter((c) => c.exact[f]).length / reachable.length).toFixed(3)) : null,
    distinct_original_values: counts.size,
    ...(f === "problem_type"
      ? { track_agreement: rows.length ? Number((rows.filter((c) => BUG.has(c.original[f] as string) === BUG.has(c.proposed[f] as string) && c.proposed[f]).length / rows.length).toFixed(3)) : 0 }
      : {}),
    top_confusions: [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`),
  };
}
const tagRows = comparisons.map((c) => c.tags).filter((t): t is NonNullable<Comparison["tags"]> => t !== undefined);
const situationRows = comparisons
  .map((c) => c.applies_when)
  .filter((a): a is { score: number; item_precision: number; proposed: number; original: number } => a !== undefined && "score" in a);
const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : 0);

process.stdout.write(
  `${JSON.stringify(
    {
      root: workspace.repoRoot,
      files_in_corpus: corpus.files.length,
      files_measured: comparisons.length,
      fields,
      exact,
      tags: tagRows.length
        ? { n: tagRows.length, jaccard_mean: mean(tagRows.map((t) => t.jaccard)), precision_mean: mean(tagRows.map((t) => t.precision)), recall_of_reachable_mean: mean(tagRows.map((t) => t.recall_reachable)), proposed_mean: mean(tagRows.map((t) => t.proposed)), original_mean: mean(tagRows.map((t) => t.original)) }
        : null,
      applies_when: fields.includes("applies_when")
        ? {
            n: comparisons.length,
            proposed: situationRows.length,
            needs_author: comparisons.filter((c) => c.applies_when && "needs_author" in c.applies_when).length,
            judged_same_mean: mean(situationRows.map((s) => s.score)),
            judged_same_at_0_6: situationRows.length ? Number((situationRows.filter((s) => s.score >= 0.6).length / situationRows.length).toFixed(3)) : 0,
            item_precision_mean: mean(situationRows.map((s) => s.item_precision)),
            proposed_items_mean: mean(situationRows.map((s) => s.proposed)),
            original_items_mean: mean(situationRows.map((s) => s.original)),
          }
        : null,
      needs_author_by_field: Object.fromEntries(
        fields.map((f) => [f, comparisons.filter((c) => c.needs_author.includes(f)).length]),
      ),
      usage: judge.usage.snapshot(),
    },
    null,
    2,
  )}\n`,
);
