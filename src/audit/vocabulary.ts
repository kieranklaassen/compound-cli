import type { SplitDocument } from "./document.ts";

/**
 * What the corpus already says. Open-vocabulary fields (module, component,
 * root_cause) follow the schema's corpus-first rule: the value existing docs
 * use for an area, most-used spelling first. Tags form the controlled
 * vocabulary the tag fixer chooses from.
 */
export type Vocabulary = {
  module: string[];
  component: string[];
  root_cause: string[];
  /** Tags used by at least two files, most frequent first, at most `TAG_VOCABULARY_MAX`. */
  tags: string[];
};

export const TAG_VOCABULARY_MAX = 60;

export function buildVocabulary(documents: Iterable<SplitDocument>): Vocabulary {
  const counts: Record<keyof Vocabulary, Map<string, number>> = {
    module: new Map(),
    component: new Map(),
    root_cause: new Map(),
    tags: new Map(),
  };
  for (const doc of documents) {
    if (doc.parseError) continue;
    for (const field of ["module", "component", "root_cause"] as const) {
      const value = doc.data[field];
      if (typeof value === "string" && value.trim()) bump(counts[field], value.trim());
    }
    const tags = doc.data.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags)
        if (typeof tag === "string" && tag.trim()) bump(counts.tags, tag.trim());
    }
  }
  return {
    module: ranked(counts.module),
    component: ranked(counts.component),
    root_cause: ranked(counts.root_cause),
    tags: ranked(counts.tags, 2).slice(0, TAG_VOCABULARY_MAX),
  };
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function ranked(map: Map<string, number>, minimum = 1): string[] {
  return [...map.entries()]
    .filter(([, n]) => n >= minimum)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}
