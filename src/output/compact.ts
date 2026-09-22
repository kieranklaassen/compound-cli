import type { FindResult } from "../find/result.ts";

/**
 * One tab-separated row per hit, strongest first: path, score, kind, pack id
 * or `-`, passage line range or `-`. Then one `#` trailer with counts, cost,
 * and time, for agents that read output as text.
 */
export function renderCompact(result: FindResult): string {
  const rows = result.hits.map((hit) =>
    [
      hit.path,
      hit.score.toFixed(2),
      hit.kind,
      hit.pack_id ?? "-",
      hit.passage ? `${hit.passage.start_line}-${hit.passage.end_line}` : "-",
    ].join("\t"),
  );
  rows.push(trailer(result));
  return `${rows.join("\n")}\n`;
}

export function trailer(result: FindResult): string {
  const u = result.usage;
  const parts = [
    `# hits=${result.hits.length}`,
    `nothing_relevant=${result.nothing_relevant}`,
    `threshold=${result.threshold}`,
    `judged=${result.corpus.judged}`,
    `solutions=${result.corpus.solutions}`,
    `pack_rules=${result.corpus.pack_rules}`,
    `pack_candidates=${result.corpus.pack_candidates}`,
  ];
  if (result.gate) parts.push(`gate=${result.gate.probability}`);
  parts.push(
    `requests=${u.requests}`,
    `tokens=${u.input_tokens}`,
    `usd=${u.estimated_usd}`,
    `ms=${u.wall_ms}`,
  );
  if (result.warnings.length) parts.push(`warnings=${result.warnings.length}`);
  return parts.join(" ");
}
