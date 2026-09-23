import type { CaseResult, EvalReport } from "./run.ts";

const pct = (value: number | null): string =>
  value === null ? "-" : `${(value * 100).toFixed(1)}%`;

/** The plugin-evals style table: one row per case, totals, then the floors. */
export function renderEval(report: EvalReport): string {
  const lines: string[] = [];
  const idWidth = Math.min(60, Math.max(4, ...report.cases.map((c) => c.id.length)));
  lines.push(
    `${"case".padEnd(idWidth)}  ${"kind".padEnd(12)} ${"result".padEnd(6)} ${"score".padStart(5)} ${"ms".padStart(6)} ${"cost".padStart(9)}  notes`,
  );
  for (const c of report.cases) {
    if (!c) continue;
    lines.push(row(c, idWidth));
  }
  lines.push("");
  const ran = report.passed + report.failed;
  const parts = [`${ran} cases`, `${report.passed} passed`, `${report.failed} failed`];
  if (report.skipped) parts.push(`${report.skipped} skipped`);
  if (report.find) {
    parts.push(
      `find macro recall ${pct(report.find.macro_recall)}`,
      `precision ${pct(report.find.precision_lower_bound)}`,
      `negatives ${pct(report.find.negatives_correct)}`,
    );
  }
  if (report.suggest) {
    parts.push(
      `suggest macro recall ${pct(report.suggest.macro_recall)}`,
      `suggest negatives ${pct(report.suggest.negatives_correct)}`,
    );
  }
  if (report.near_miss_correct !== null)
    parts.push(`near misses held ${pct(report.near_miss_correct)}`);
  parts.push(
    `$${report.cost.total_usd.toFixed(4)}`,
    `${report.latency_ms.median === null ? "-" : `${report.latency_ms.median} ms median`}`,
    `${report.cassette_mode === "off" ? "live" : report.cassette_mode}`,
  );
  lines.push(`totals: ${parts.join(", ")}`);
  if (report.cost_cap.reached) {
    lines.push(`cost cap: $${report.cost_cap.limit_usd} reached; ${report.skipped} cases not run`);
  }
  const floors = Object.entries(report.floors);
  if (floors.length) {
    lines.push(
      `floors: ${floors
        .map(([key, value]) => {
          const label = key.replaceAll("_", " ");
          const failed = report.floor_failures.some((f) => f.includes(label));
          return `${label} ${value} ${failed ? "FAIL" : "ok"}`;
        })
        .join(", ")}`,
    );
  }
  for (const failure of report.floor_failures) lines.push(`floor: ${failure}`);
  if (report.sweep.length) {
    lines.push("");
    lines.push("threshold  macro recall  micro recall  precision  negatives  perfect");
    for (const s of report.sweep) {
      lines.push(
        `${s.threshold.toFixed(2).padStart(9)}  ${pct(s.macro_recall).padStart(12)}  ${pct(s.micro_recall).padStart(12)}  ${pct(s.precision_lower_bound).padStart(9)}  ${pct(s.negatives_correct).padStart(9)}  ${String(s.perfect_cases).padStart(7)}`,
      );
    }
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function row(c: CaseResult, idWidth: number): string {
  const kind = c.channels.join("+");
  const score = c.score === null ? "-" : c.score.toFixed(2);
  const notes = c.notes.join("; ");
  return `${c.id.slice(0, idWidth).padEnd(idWidth)}  ${kind.padEnd(12)} ${c.result.padEnd(6)} ${score.padStart(5)} ${String(c.wall_ms).padStart(6)} ${`$${c.estimated_usd.toFixed(5)}`.padStart(9)}  ${notes}`;
}
