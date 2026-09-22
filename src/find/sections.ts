import { DEFAULTS } from "./defaults.ts";

export type Section = {
  heading: string;
  /** 1-based, absolute within the file. */
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
};

const MIN_SECTION_CHARS = 200;

/**
 * Split a body at ATX headings into at most `maxSections` sections whose line
 * ranges tile the body, then fit their text into `excerptChars` in total.
 * Small neighbors merge first so every section keeps enough text to judge.
 */
export function splitSections(
  body: string,
  bodyStartLine: number,
  fallbackHeading: string,
  options: { maxSections?: number; excerptChars?: number } = {},
): Section[] {
  const maxSections = options.maxSections ?? DEFAULTS.maxSections;
  const excerptChars = options.excerptChars ?? DEFAULTS.excerptChars;
  const lines = body.split(/\r?\n/);
  type Raw = { heading: string; start: number; end: number };
  const raws: Raw[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) return;
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match?.[1]) raws.push({ heading: match[1].trim(), start: index, end: index });
  });
  if (raws.length === 0 || (raws[0]?.start ?? 0) > 0) {
    raws.unshift({ heading: raws.length ? "(intro)" : fallbackHeading, start: 0, end: 0 });
  }
  for (let i = 0; i < raws.length; i++) {
    const current = raws[i] as Raw;
    current.end = (raws[i + 1]?.start ?? lines.length) - 1;
  }
  // Drop empty leading intro (a body that starts with its H1 and nothing before it).
  const nonEmpty = raws.filter((raw) => lines.slice(raw.start, raw.end + 1).some((l) => l.trim()));
  const kept = nonEmpty.length ? nonEmpty : raws.slice(0, 1);

  let merged: Raw[] = kept.map((r) => ({ ...r }));
  while (merged.length > Math.max(1, maxSections)) {
    let smallest = 0;
    let smallestSize = Number.POSITIVE_INFINITY;
    merged.forEach((raw, index) => {
      const size = sizeOf(lines, raw);
      if (size < smallestSize) {
        smallestSize = size;
        smallest = index;
      }
    });
    const left = merged[smallest - 1];
    const right = merged[smallest + 1];
    const target = merged[smallest] as Raw;
    if (left && (!right || sizeOf(lines, left) <= sizeOf(lines, right))) {
      left.end = target.end;
      merged.splice(smallest, 1);
    } else if (right) {
      right.start = target.start;
      right.heading = `${target.heading} / ${right.heading}`;
      merged.splice(smallest, 1);
    } else {
      break;
    }
  }
  if (merged.length > 1) merged = merged.map((raw) => ({ ...raw }));

  const sizes = merged.map((raw) => sizeOf(lines, raw));
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return merged.map((raw, index) => {
    const full = lines
      .slice(raw.start, raw.end + 1)
      .join("\n")
      .trim();
    const share = Math.max(
      MIN_SECTION_CHARS,
      Math.floor((excerptChars * (sizes[index] ?? 0)) / total),
    );
    const budget = Math.min(full.length, total <= excerptChars ? full.length : share);
    const text = budget >= full.length ? full : truncateAtLine(full, budget);
    return {
      heading: raw.heading,
      startLine: bodyStartLine + raw.start,
      endLine: bodyStartLine + raw.end,
      text,
      truncated: text.length < full.length,
    };
  });
}

function sizeOf(lines: string[], raw: { start: number; end: number }): number {
  let size = 0;
  for (let i = raw.start; i <= raw.end; i++) size += (lines[i]?.length ?? 0) + 1;
  return size;
}

function truncateAtLine(text: string, budget: number): string {
  const cut = text.slice(0, budget);
  const lastBreak = cut.lastIndexOf("\n");
  const kept = lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut;
  return `${kept.trimEnd()}\n[...]`;
}
