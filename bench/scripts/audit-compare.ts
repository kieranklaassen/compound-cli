/**
 * Compare what `audit --fix --dry-run --report` proposed against frontmatter
 * a person wrote for the same files (another branch or checkout). Exact match
 * for scalar fields, precision and recall for tags, and for applies_when and
 * symptoms one Jev request per file: whole-list equivalence plus one Noul per
 * proposed item asking whether the hand-written list covers it.
 *
 *   --report <dry-run json>   the audit report with fix.changes
 *   --handwritten <root>      checkout holding the hand-written frontmatter (same paths)
 *   --jobs <n>                concurrent files (default 4)
 * Environment: TYPESAFE_API_KEY (or cassette replay).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { noul } from "@typesafe-ai/sdk";
import { splitDocument } from "../../src/audit/document.ts";
import type { AuditReport } from "../../src/audit/report.ts";
import { processContext } from "../../src/context.ts";
import { judgeFromEnv, noulOf } from "../../src/judge/client.ts";
import { Semaphore } from "../../src/judge/semaphore.ts";

const { values } = parseArgs({
  options: {
    report: { type: "string" },
    handwritten: { type: "string" },
    jobs: { type: "string", default: "4" },
  },
});
if (!values.report || !values.handwritten) throw new Error("--report and --handwritten are required");
const report = JSON.parse(readFileSync(values.report, "utf8")) as AuditReport;
const judge = judgeFromEnv(processContext().env, {});

const SCALARS = ["problem_type", "module", "component", "severity", "root_cause", "resolution_type", "date", "title"];
const LISTS = ["applies_when", "symptoms"] as const;

type Row = {
  path: string;
  scalar: Record<string, { proposed: string; handwritten: string | null; agree: boolean }>;
  tags?: { precision: number; recall: number; proposed: number; handwritten: number };
  lists: Partial<
    Record<
      (typeof LISTS)[number],
      { same: number; item_precision: number; proposed: number; handwritten: number } | { skipped: string }
    >
  >;
  needs_author: string[];
};

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

const files = report.files.filter((f) => f.fix && (f.fix.changes.length || f.fix.needs_author.length));
const gate = new Semaphore(Number(values.jobs));
const rows: Row[] = [];

await Promise.all(
  files.map((file) =>
    gate.run(async () => {
      const handPath = join(values.handwritten as string, file.path);
      if (!existsSync(handPath)) return;
      const hand = splitDocument(readFileSync(handPath, "utf8")).data;
      const changes = new Map((file.fix?.changes ?? []).map((c) => [c.field, c.value]));
      const row: Row = { path: file.path, scalar: {}, lists: {}, needs_author: (file.fix?.needs_author ?? []).map((n) => n.field) };
      for (const field of SCALARS) {
        if (!changes.has(field)) continue;
        const proposed = norm(changes.get(field));
        const written = hand[field] === undefined ? null : norm(hand[field]);
        row.scalar[field] = { proposed, handwritten: written, agree: written !== null && proposed === written };
      }
      if (changes.has("tags")) {
        const proposed = new Set(list(changes.get("tags")).map(norm));
        const written = new Set(list(hand.tags).map(norm));
        const shared = [...proposed].filter((t) => written.has(t)).length;
        row.tags = {
          precision: proposed.size ? shared / proposed.size : 0,
          recall: written.size ? shared / written.size : 0,
          proposed: proposed.size,
          handwritten: written.size,
        };
      }
      for (const field of LISTS) {
        if (!changes.has(field)) continue;
        const proposed = list(changes.get(field));
        const written = list(hand[field]);
        if (!proposed.length) continue;
        if (!written.length) {
          row.lists[field] = { skipped: "the hand-written frontmatter has no list to compare with" };
          continue;
        }
        const items: Record<string, string> = {};
        proposed.forEach((text, index) => {
          items[`p${String(index).padStart(2, "0")}`] = text;
        });
        const noun = field === "applies_when" ? "situations in which someone should read the learning" : "observable symptoms of the problem the learning records";
        const questions: Record<string, ReturnType<typeof noul>> = {
          same: noul(
            `Do the ${noun} under \`proposed\` describe the same things as those under \`handwritten\`, in substance if not in wording? No when either list names something the other does not cover.`,
          ),
        };
        for (const tag of Object.keys(items)) {
          questions[`covered.${tag}`] = noul(
            `Is the item tagged ${tag} under \`proposed\` covered by some item under \`handwritten\`: would the author of \`handwritten\` agree it belongs on their list?`,
          );
        }
        const answers = await judge.ask(
          { task: `Two lists each describe the ${noun}. \`handwritten\` was written by a person; \`proposed\` was extracted from the body by a tool.`, handwritten: written, proposed: items },
          questions,
        );
        const covered = Object.keys(items).map((tag) => noulOf(answers, `covered.${tag}`));
        row.lists[field] = {
          same: noulOf(answers, "same"),
          item_precision: covered.filter((c) => c >= 0.6).length / covered.length,
          proposed: proposed.length,
          handwritten: written.length,
        };
      }
      rows.push(row);
      process.stderr.write(`${file.path}\n`);
    }),
  ),
);

const mean = (xs: number[]) => (xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null);
const scalar: Record<string, unknown> = {};
for (const field of SCALARS) {
  const cells = rows.map((r) => r.scalar[field]).filter((c): c is NonNullable<typeof c> => c !== undefined);
  const comparable = cells.filter((c) => c.handwritten !== null);
  const confusion = new Map<string, number>();
  for (const c of comparable) if (!c.agree) confusion.set(`${c.handwritten} -> ${c.proposed}`, (confusion.get(`${c.handwritten} -> ${c.proposed}`) ?? 0) + 1);
  scalar[field] = {
    proposed: cells.length,
    comparable: comparable.length,
    agree: comparable.filter((c) => c.agree).length,
    rate: comparable.length ? Number((comparable.filter((c) => c.agree).length / comparable.length).toFixed(3)) : null,
    top_confusions: [...confusion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`),
  };
}
const tagRows = rows.map((r) => r.tags).filter((t): t is NonNullable<Row["tags"]> => t !== undefined);
const lists: Record<string, unknown> = {};
for (const field of LISTS) {
  const judged = rows.map((r) => r.lists[field]).filter((l): l is { same: number; item_precision: number; proposed: number; handwritten: number } => l !== undefined && "same" in l);
  const skipped = rows.filter((r) => r.lists[field] && "skipped" in (r.lists[field] as object)).length;
  lists[field] = {
    proposed_files: judged.length + skipped,
    judged: judged.length,
    skipped_no_handwritten_list: skipped,
    judged_same_mean: mean(judged.map((j) => j.same)),
    judged_same_at_0_6: judged.length ? Number((judged.filter((j) => j.same >= 0.6).length / judged.length).toFixed(3)) : null,
    item_precision_mean: mean(judged.map((j) => j.item_precision)),
    proposed_items_mean: mean(judged.map((j) => j.proposed)),
    handwritten_items_mean: mean(judged.map((j) => j.handwritten)),
  };
}
const needs = new Map<string, number>();
for (const r of rows) for (const f of r.needs_author) needs.set(f, (needs.get(f) ?? 0) + 1);

process.stdout.write(
  `${JSON.stringify(
    {
      files_with_proposals: rows.length,
      scalar,
      tags: tagRows.length ? { files: tagRows.length, precision_mean: mean(tagRows.map((t) => t.precision)), recall_mean: mean(tagRows.map((t) => t.recall)), proposed_mean: mean(tagRows.map((t) => t.proposed)), handwritten_mean: mean(tagRows.map((t) => t.handwritten)) } : null,
      lists,
      needs_author_by_field: Object.fromEntries([...needs.entries()].sort((a, b) => b[1] - a[1])),
      usage: judge.usage.snapshot(),
    },
    null,
    2,
  )}\n`,
);
