const STOPWORDS = new Set(
  `a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing done down during each few for from further had
has have having he her here hers him his how i if in into is it its itself just let like me more most my
no nor not now of off on once only or other our ours out over own same she should so some such than that
the their theirs them then there these they this those through to too under until up us very was we were
what when where which while who whom why will with would you your yours
add adds added adding make makes making use uses used using get gets got new one two via want need needs
should must may might`.split(/\s+/),
);

const TOKEN = /[a-z0-9][a-z0-9_./-]*[a-z0-9]|[a-z0-9]/g;

/**
 * Stopword-stripped keywords from free text, unique and in order of first
 * appearance. Identifiers (`snake_case`, `kebab-case`, `dotted.names`) and
 * paths stay whole, and their parts are added after them so a partial
 * mention still overlaps.
 */
export function extractKeywords(...texts: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (token: string) => {
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) return;
    if (seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.toLowerCase().matchAll(TOKEN)) {
      const token = match[0].replace(/^[./-]+|[./-]+$/g, "");
      if (!token) continue;
      push(token);
      const segments = token.split("/").filter(Boolean);
      for (const segment of segments) {
        if (segments.length > 1) push(segment);
        const parts = segment.split(/[_.-]+/).filter(Boolean);
        if (parts.length > 1) for (const part of parts) push(part);
      }
    }
  }
  return out;
}

export function keywordOverlap(keywords: readonly string[], text: string): string[] {
  if (!keywords.length || !text) return [];
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9_./-]+/g, " ")} `;
  return keywords.filter((keyword) => haystack.includes(keyword));
}
