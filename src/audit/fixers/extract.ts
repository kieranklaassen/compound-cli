/**
 * Candidate situation and symptom sentences, taken from the body so the judge
 * only ever confirms what the author wrote. Nothing here invents text.
 */

export const CANDIDATE_MAX = 12;
const MIN_CHARS = 6;
const MAX_CHARS = 200;

const SITUATION_OPENERS = /^(when|if|whenever|before|after|deciding|while|once)\b/i;
const FAILURE_PHRASING =
  /\b(error|errors|fails?|failed|failing|hangs?|hung|times? out|timed out|regression|silently|crash(es|ed)?|stale|duplicate|race|leak|slow|stuck)\b/i;
const SECTION_LEADS =
  /^#{2,3}\s+(problem|context|symptoms?|situation|when|rule|the rule|decision)\b/i;

type Extracted = { text: string; why: string };

export function extractSituations(body: string): Extracted[] {
  return extract(body, "situation");
}

export function extractSymptoms(body: string): Extracted[] {
  return extract(body, "symptom");
}

function extract(body: string, mode: "situation" | "symptom"): Extracted[] {
  const prose = body
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/^\s*\|.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  const out: Extracted[] = [];
  const seen = new Set<string>();
  const push = (text: string, why: string) => {
    const clean = tidy(text);
    if (!clean || clean.length < MIN_CHARS || clean.length > MAX_CHARS) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: clean, why });
  };

  const lines = prose.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < CANDIDATE_MAX; i++) {
    const line = lines[i] ?? "";
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const text = heading[1] ?? "";
      if (
        mode === "situation" &&
        !/^(problem|solution|context|prevention|references?|see also|notes?|summary|background|root cause|fix|why|how|what)$/i.test(
          text,
        )
      ) {
        push(text, "heading");
      }
      if (SECTION_LEADS.test(line)) {
        const lead = firstSentenceAfter(lines, i + 1);
        if (lead) push(lead, "section lead");
      }
      continue;
    }
    for (const sentence of sentences(line)) {
      if (mode === "situation" && SITUATION_OPENERS.test(sentence))
        push(sentence, "situation opener");
      if (FAILURE_PHRASING.test(sentence))
        push(sentence, mode === "situation" ? "failure phrasing" : "symptom phrasing");
    }
  }
  return out.slice(0, CANDIDATE_MAX);
}

function firstSentenceAfter(lines: string[], from: number): string | undefined {
  for (let i = from; i < Math.min(lines.length, from + 6); i++) {
    const line = (lines[i] ?? "").trim();
    if (!line || line.startsWith("#")) {
      if (line.startsWith("#")) return undefined;
      continue;
    }
    return sentences(line)[0];
  }
  return undefined;
}

function sentences(line: string): string[] {
  const text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tidy(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/[.:;,]+$/, "")
    .trim();
}
