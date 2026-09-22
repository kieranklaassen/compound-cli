import type { FindResult, Hit } from "../find/result.ts";

/** A readable report for a person at a terminal. */
export function renderReport(result: FindResult): string {
  const lines: string[] = [];
  const c = result.corpus;
  const corpus = `${c.solutions} learnings, ${c.pack_rules} pack rules, ${c.pack_candidates} pack candidates`;
  const head =
    result.mode === "overlap"
      ? `compound find --overlap: ${result.hits.length} overlapping (threshold ${result.threshold}) over ${corpus}`
      : `compound find: ${result.hits.length} ${result.hits.length === 1 ? "hit" : "hits"} (threshold ${result.threshold}) over ${corpus}`;
  lines.push(head, "");
  if (result.hits.length === 0) {
    lines.push("nothing relevant: no candidate met the threshold", "");
  }
  for (const hit of result.hits) lines.push(...renderHit(hit), "");
  if (result.gate) {
    lines.push(
      `gate: ${result.gate.probability} with ${result.gate.hits} ${result.gate.hits === 1 ? "hit" : "hits"} at or above ${result.gate.threshold}`,
      "",
    );
  }
  const u = result.usage;
  lines.push(
    `usage: ${u.requests} ${u.requests === 1 ? "request" : "requests"}, ${u.input_tokens.toLocaleString("en-US")} input tokens, $${u.estimated_usd.toFixed(5)}, ${u.wall_ms.toLocaleString("en-US")} ms${u.model ? `, model ${u.model}` : ""}`,
  );
  if (c.filtered_out.total)
    lines.push(`filters removed ${c.filtered_out.total} candidates before judging`);
  if (c.prefilter_dropped)
    lines.push(
      `prefilter dropped ${c.prefilter_dropped} candidates without applies_when (raise --candidate-cap to judge them)`,
    );
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

function renderHit(hit: Hit): string[] {
  const lines = [
    `${hit.score.toFixed(2)}  ${hit.path}${hit.kind === "solution" ? "" : `  [${hit.kind}]`}`,
  ];
  lines.push(`      ${hit.title}`);
  if (hit.passage) {
    lines.push(
      `      passage: ${hit.passage.heading} (lines ${hit.passage.start_line}-${hit.passage.end_line})`,
    );
    const quote = hit.passage.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3);
    for (const line of quote) lines.push(`      > ${line.slice(0, 160)}`);
  }
  if (hit.overlap) {
    const o = hit.overlap;
    lines.push(
      `      overlap: problem ${o.problem.toFixed(2)}, root cause ${o.root_cause.toFixed(2)}, solution ${o.solution.toFixed(2)}, files ${o.files.toFixed(2)}, prevention ${o.prevention.toFixed(2)}`,
    );
  }
  if (hit.declaration) {
    lines.push("      declare with:");
    lines.push("        packs:");
    const entries = Object.entries(hit.declaration);
    entries.forEach(([key, value], index) =>
      lines.push(`          ${index === 0 ? "- " : "  "}${key}: ${value}`),
    );
  }
  if (hit.matched_fields.length) lines.push(`      matched: ${hit.matched_fields.join(", ")}`);
  return lines;
}
