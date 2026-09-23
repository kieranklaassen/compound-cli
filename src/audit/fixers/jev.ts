import { choiceOf, type Judge, noulOf } from "../../judge/client.ts";
import {
  AUDIT_NOUL_QUESTIONS,
  type AuditChoice,
  type AuditNoulSet,
  auditChoiceRequest,
  auditNoulRequest,
} from "../../judge/questions.ts";
import type { SplitDocument } from "../document.ts";
import { DEFAULT_SCHEMA, type EffectiveField } from "../effective-schema.ts";
import { type Finding, isCorpusVocabulary, isGenericAppliesWhen } from "../rules.ts";
import { LIMITS, PROBLEM_TYPE_DESCRIPTIONS, TAG_PATTERN } from "../schema.ts";
import type { Vocabulary } from "../vocabulary.ts";
import type { FieldChange } from "../writer.ts";
import { extractSituations, extractSymptoms } from "./extract.ts";

/**
 * Fixes that need judgment. Enum and vocabulary fields are one Choice each,
 * batched into one request per file; tags, applies_when, and symptoms are
 * Nouls over a controlled set (the corpus's tags, or sentences extracted from
 * the body), batched into a second request. When nothing clears the bar the
 * field is handed back to the author, never invented.
 */

export type NeedsAuthor = { field: string; reason: string };

export type JevFixResult = { changes: FieldChange[]; needsAuthor: NeedsAuthor[] };

export const THRESHOLDS = {
  /** A Choice answer below this probability is not a decision. */
  choice: 0.4,
  tag: 0.6,
  situation: 0.7,
  symptom: 0.7,
} as const;

const EXCERPT_CHARS = 6000;

export function documentView(doc: SplitDocument, path: string): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc.data)) {
    if (typeof value === "string") frontmatter[key] = value.slice(0, 300);
    else if (Array.isArray(value))
      frontmatter[key] = value
        .slice(0, 8)
        .map((v) => (typeof v === "string" ? v.slice(0, 300) : v));
    else frontmatter[key] = value;
  }
  const excerpt = doc.body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, EXCERPT_CHARS);
  return { path, title: doc.data.title ?? null, frontmatter, excerpt };
}

function tagged(values: string[], prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  values.forEach((value, index) => {
    out[`${prefix}${String(index).padStart(2, "0")}`] = value;
  });
  return out;
}

function plain(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) out[value] = value;
  return out;
}

export async function jevFixes(
  judge: Judge,
  doc: SplitDocument,
  path: string,
  findings: Finding[],
  vocabulary: Vocabulary,
  fields: EffectiveField[] = DEFAULT_SCHEMA.solution,
): Promise<JevFixResult> {
  const rules = new Set(findings.map((f) => f.rule));
  const changes: FieldChange[] = [];
  const needsAuthor: NeedsAuthor[] = [];
  const document = documentView(doc, path);
  const spec = (name: string) => fields.find((f) => f.name === name);
  const tagPattern = new RegExp(spec("tags")?.pattern ?? TAG_PATTERN.source);
  // List caps come from the effective schema, so a repository that tightens max_items never
  // gets a list from the judge that its own audit then flags as too_many.
  const cap = (name: string, fallback: number) => spec(name)?.maxItems ?? fallback;

  // One Choice per value field the rules flagged, over the effective values: a closed
  // field's list (the schema's, or the repository's), else the corpus's own values,
  // else the schema's suggestions. The repository's list always wins over the defaults.
  const choices: AuditChoice[] = [];
  for (const field of fields) {
    if (field.type === "list" || field.type === "date") continue;
    const name = field.name;
    // A value field the judge can settle: it has a list to choose from (the schema's,
    // the repository's, or the corpus's). Title has none; it is the deterministic fixer's.
    const judged = field.closed || field.values.length > 0 || isCorpusVocabulary(name);
    if (!judged || !(rules.has(`${name}.missing`) || rules.has(`${name}.invalid`))) continue;
    const enumUsage = (vocabulary.enum_usage as Record<string, Record<string, number> | undefined>)[
      name
    ];
    if (field.closed) {
      const choice: AuditChoice = { field: name, options: plain(field.values), tagged: false };
      if (name === "problem_type") {
        choice.descriptions = Object.fromEntries(
          field.values
            .filter((v) => v in PROBLEM_TYPE_DESCRIPTIONS)
            .map((v) => [
              v,
              PROBLEM_TYPE_DESCRIPTIONS[v as keyof typeof PROBLEM_TYPE_DESCRIPTIONS],
            ]),
        );
      }
      if (enumUsage) choice.usage = enumUsage;
      choices.push(choice);
      continue;
    }
    const corpus = isCorpusVocabulary(name)
      ? vocabulary[name as "module" | "component" | "root_cause"]
      : [];
    if (corpus.length >= 2) {
      const labels = tagged(corpus, "v");
      const usage: Record<string, number> = {};
      const counts = (vocabulary.usage as Record<string, Record<string, number> | undefined>)[name];
      for (const [tag, value] of Object.entries(labels)) usage[tag] = counts?.[value] ?? 0;
      choices.push({ field: name, options: labels, tagged: true, usage });
    } else if (field.values.length) {
      choices.push({ field: name, options: plain(field.values), tagged: false });
    } else {
      needsAuthor.push({
        field: name,
        reason: `the corpus uses ${corpus.length === 1 ? "only one" : "no"} ${name} value, so there is nothing to choose from`,
      });
    }
  }

  if (choices.length) {
    const request = auditChoiceRequest(document, choices);
    const answers = await judge.ask(request.state, request.questions);
    for (const choice of choices) {
      const answer = choiceOf(answers, choice.field);
      const picked = answer?.choice;
      const probabilities = (answer?.probabilities ?? {}) as Record<string, number>;
      const probability = picked === undefined ? 0 : (probabilities[picked] ?? 0);
      const value = picked === undefined ? undefined : choice.options[picked];
      if (value !== undefined && probability >= THRESHOLDS.choice) {
        changes.push({
          field: choice.field,
          value,
          source: "jev",
          score: round(probability),
          note: choice.tagged
            ? "chosen among the corpus's values"
            : fields.find((f) => f.name === choice.field)?.sources.values === "default"
              ? "chosen among the schema's values"
              : "chosen among the repository's values",
        });
      } else {
        needsAuthor.push({
          field: choice.field,
          reason:
            value === undefined
              ? "the judge gave no answer"
              : `the judge's best answer (${value}) was only ${round(probability)}, under ${THRESHOLDS.choice}`,
        });
      }
    }
  }

  const sets: AuditNoulSet[] = [];
  const existingTags = Array.isArray(doc.data.tags)
    ? doc.data.tags.filter((t): t is string => typeof t === "string" && tagPattern.test(t))
    : [];
  const wantTags = rules.has("tags.missing") && vocabulary.tags.length > 0;
  if (wantTags) {
    sets.push({
      field: "tags",
      items: tagged(
        vocabulary.tags.filter((t) => !existingTags.includes(t)),
        "t",
      ),
      question: AUDIT_NOUL_QUESTIONS.tags,
    });
  } else if (rules.has("tags.missing")) {
    needsAuthor.push({
      field: "tags",
      reason: "the corpus has no tag used by two or more files to choose from",
    });
  }

  const title = typeof doc.data.title === "string" ? doc.data.title : undefined;
  const existingSituations = Array.isArray(doc.data.applies_when)
    ? doc.data.applies_when.filter(
        (s): s is string => typeof s === "string" && !isGenericAppliesWhen(s, title),
      )
    : [];
  const wantSituations = rules.has("applies_when.missing") || rules.has("applies_when.generic");
  let situations: Record<string, string> = {};
  if (wantSituations) {
    situations = tagged(
      extractSituations(doc.body)
        .map((c) => c.text)
        .filter((c) => !existingSituations.includes(c) && !isGenericAppliesWhen(c, title)),
      "c",
    );
    if (Object.keys(situations).length) {
      sets.push({
        field: "applies_when",
        items: situations,
        question: AUDIT_NOUL_QUESTIONS.applies_when,
      });
    } else {
      needsAuthor.push({
        field: "applies_when",
        reason: "the body yields no situation sentence to judge",
      });
    }
  }

  const wantSymptoms = rules.has("symptoms.missing");
  let symptoms: Record<string, string> = {};
  if (wantSymptoms) {
    symptoms = tagged(
      extractSymptoms(doc.body).map((c) => c.text),
      "s",
    );
    if (Object.keys(symptoms).length) {
      sets.push({ field: "symptoms", items: symptoms, question: AUDIT_NOUL_QUESTIONS.symptoms });
    } else {
      needsAuthor.push({
        field: "symptoms",
        reason: "the body yields no symptom sentence to judge",
      });
    }
  }

  if (sets.length) {
    const request = auditNoulRequest(document, sets);
    const answers = await judge.ask(request.state, request.questions);
    const scored = (set: AuditNoulSet) =>
      Object.entries(set.items)
        .map(([tag, text]) => ({ text, score: noulOf(answers, `${set.field}.${tag}`) }))
        .sort((a, b) => b.score - a.score);

    for (const set of sets) {
      const ranked = scored(set);
      if (set.field === "tags") {
        const chosen = ranked.filter((r) => r.score >= THRESHOLDS.tag).map((r) => r.text);
        const tags = [...existingTags, ...chosen].slice(0, cap("tags", LIMITS.tagsMax));
        if (chosen.length) {
          changes.push({
            field: "tags",
            value: tags,
            source: "jev",
            score: round(ranked[0]?.score ?? 0),
            note: `${chosen.length} of ${ranked.length} corpus tags judged fitting`,
          });
        } else {
          needsAuthor.push({
            field: "tags",
            reason: `no corpus tag reached ${THRESHOLDS.tag} (best ${round(ranked[0]?.score ?? 0)})`,
          });
        }
      } else if (set.field === "applies_when") {
        const room = Math.max(
          0,
          cap("applies_when", LIMITS.appliesWhenMax) - existingSituations.length,
        );
        const chosen = ranked.filter((r) => r.score >= THRESHOLDS.situation).slice(0, room);
        if (chosen.length) {
          changes.push({
            field: "applies_when",
            value: [...existingSituations, ...chosen.map((c) => c.text)],
            source: "jev",
            score: round(chosen[0]?.score ?? 0),
            note: `${chosen.length} of ${ranked.length} extracted sentences judged as situations`,
          });
        } else if (existingSituations.length && rules.has("applies_when.generic")) {
          changes.push({
            field: "applies_when",
            value: existingSituations,
            source: "jev",
            score: round(ranked[0]?.score ?? 0),
            note: "dropped the generic items; no extracted sentence replaced them",
          });
        } else {
          needsAuthor.push({
            field: "applies_when",
            reason: `no extracted sentence reached ${THRESHOLDS.situation} (best ${round(ranked[0]?.score ?? 0)}: "${ranked[0]?.text ?? ""}")`,
          });
        }
      } else if (set.field === "symptoms") {
        const chosen = ranked
          .filter((r) => r.score >= THRESHOLDS.symptom)
          .slice(0, cap("symptoms", LIMITS.symptomsMax));
        if (chosen.length) {
          changes.push({
            field: "symptoms",
            value: chosen.map((c) => c.text),
            source: "jev",
            score: round(chosen[0]?.score ?? 0),
            note: `${chosen.length} of ${ranked.length} extracted sentences judged as symptoms`,
          });
        } else {
          needsAuthor.push({
            field: "symptoms",
            reason: `no extracted sentence reached ${THRESHOLDS.symptom}`,
          });
        }
      }
    }
  }

  return { changes, needsAuthor };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
