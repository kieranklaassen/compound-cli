import { type ChoiceCriteria, choice, noul, type Questions, score } from "@typesafe-ai/sdk";
import { type Candidate, type CandidateKind, stringField } from "../corpus/candidate.ts";
import type { Section } from "../find/sections.ts";

/**
 * Every question the CLI asks Jev, in one place. Wording follows jegrep's lean
 * form: criteria are stated once in the state and each question refers to the
 * candidate by its tag. Candidate text (titles, headings, bodies) is always
 * data under `state`, never part of an instruction or a Choice label (plan
 * KTD19): a pack author must not be able to steer the judge from inside a
 * document.
 */

export type JudgeWork = Record<string, unknown>;

export function candidateTag(index: number): string {
  return `c${String(index).padStart(3, "0")}`;
}

export function sectionTag(index: number): string {
  return `s${String(index).padStart(2, "0")}`;
}

const TIER_ONE_TASK =
  "Decide which recorded learnings and pack rules apply to the work described in `work`. Each candidate is judged from its frontmatter and its outline: its title, the applies_when situations its author wrote, tags, module, problem type, component, symptoms, and section headings.";

const APPLIES_CRITERIA = {
  yes: "The candidate's situation, problem, rule, or decision is one this work is in or will meet, so the person doing the work should read it before proceeding.",
  no: "The candidate concerns a different situation, component, or kind of problem, or shares only vocabulary with the work without bearing on it.",
};

const ADOPT_CRITERIA = {
  yes: "The pack's applies_when names a situation this work is in, so its rules would be worth consulting for this work.",
  no: "The pack is about a different domain, person, or kind of decision than this work involves.",
};

const KIND_LABELS: Record<CandidateKind, string> = {
  solution: "learning",
  pack_rule: "pack rule",
  pack_candidate: "pack",
};

/** Bounds on what one candidate contributes to a shared state, so no document can crowd out the batch. */
const VIEW_LIMITS = { title: 300, listItems: 8, listItemChars: 300, scalar: 120 };

export function frontmatterView(candidate: Candidate): Record<string, unknown> {
  const fm = candidate.frontmatter;
  const view: Record<string, unknown> = {
    path: candidate.path.slice(0, VIEW_LIMITS.title),
    kind: KIND_LABELS[candidate.kind],
    title: candidate.title.slice(0, VIEW_LIMITS.title),
  };
  if (candidate.packId) view.pack = candidate.packId.slice(0, VIEW_LIMITS.scalar);
  if (candidate.appliesWhen.length) view.applies_when = boundedList(candidate.appliesWhen);
  if (candidate.tags.length) view.tags = boundedList(candidate.tags);
  for (const key of ["module", "problem_type", "component", "record_type"] as const) {
    const value = stringField(fm[key]);
    if (value !== undefined) view[key] = value.slice(0, VIEW_LIMITS.scalar);
  }
  const symptoms = fm.symptoms;
  if (Array.isArray(symptoms) && symptoms.length) {
    view.symptoms = boundedList(symptoms.filter((s): s is string => typeof s === "string"));
  }
  return view;
}

function boundedList(items: string[]): string[] {
  return items
    .slice(0, VIEW_LIMITS.listItems)
    .map((item) => item.slice(0, VIEW_LIMITS.listItemChars));
}

/** The document's section headings, bounded: an outline of what the body covers. */
export function bodyHeadings(body: string, limit = 8): string[] {
  const out: string[] = [];
  const prose = body.replace(/```[\s\S]*?```/g, "");
  for (const match of prose.matchAll(/^#{2,3}[ \t]+(.+?)[ \t]*$/gm)) {
    const heading = (match[1] ?? "").replace(/[*_`]/g, "").trim();
    if (heading && !out.includes(heading)) out.push(heading.slice(0, 80));
    if (out.length >= limit) break;
  }
  return out;
}

export function tierOneRequest(
  work: JudgeWork,
  batch: Candidate[],
): { state: Record<string, unknown>; questions: Questions; tags: Map<string, Candidate> } {
  const candidates: Record<string, unknown> = {};
  const questions: Questions = {};
  const tags = new Map<string, Candidate>();
  batch.forEach((candidate, index) => {
    const tag = candidateTag(index);
    tags.set(tag, candidate);
    const headings = bodyHeadings(candidate.body);
    candidates[tag] = headings.length
      ? { ...frontmatterView(candidate), headings }
      : frontmatterView(candidate);
    questions[tag] =
      candidate.kind === "pack_candidate"
        ? noul(
            `Should the pack tagged ${tag} be adopted for the work in \`work\`? Judge it from \`candidates.${tag}\`: its \`applies_when\` lists the situations that call for the pack; apply \`criteria.adopt\`.`,
          )
        : noul(
            `Does the item tagged ${tag} apply to the work in \`work\`? Judge it from \`candidates.${tag}\`: its \`applies_when\`, title, headings, tags, module, and problem type; apply \`criteria.applies\`.`,
          );
  });
  return {
    state: {
      task: TIER_ONE_TASK,
      work,
      criteria: { applies: APPLIES_CRITERIA, adopt: ADOPT_CRITERIA },
      candidates,
    },
    questions,
    tags,
  };
}

const TIER_TWO_TASK =
  "Confirm whether the document in `document` applies to the work described in `work`, now reading its content, and locate the section that applies.";

export function tierTwoRequest(
  work: JudgeWork,
  candidate: Candidate,
  sections: Section[],
): { state: Record<string, unknown>; questions: Questions } {
  const sectionMap: Record<string, unknown> = {};
  const where: Record<string, string> = {};
  sections.forEach((section, index) => {
    const tag = sectionTag(index);
    sectionMap[tag] = {
      heading: section.heading,
      lines: `${section.startLine}-${section.endLine}`,
      text: section.text,
    };
    where[tag] =
      `the section tagged ${tag} (its heading and text are under \`document.sections.${tag}\`)`;
  });
  const questions: Questions = {
    relevant: score(
      "How directly does the document in `document` apply to the work in `work`? Read its sections under `document.sections`.",
      [
        "Unrelated: a different situation, component, and kind of problem; at most shared vocabulary.",
        "Same area only: the same codebase area or technology, but its problem, rule, or decision does not come up in this work.",
        "Relevant background: its problem, rule, or decision could come up in this work; worth knowing but would not on its own change what the person does.",
        "Directly applies: this work is in, or will meet, the situation the document records; knowing it changes what the person does or checks.",
      ],
    ),
  };
  if (sections.length >= 2) {
    questions.where = choice(
      "Which section of `document.sections` most directly applies to the work in `work`? Prefer the section that states the rule, decision, or fix over background, symptoms, or references.",
      where as ChoiceCriteria,
    );
  }
  return {
    state: {
      task: TIER_TWO_TASK,
      work,
      document: {
        ...frontmatterView(candidate),
        sections: sectionMap,
      },
    },
    questions,
  };
}

export const OVERLAP_DIMENSIONS = [
  "problem",
  "root_cause",
  "solution",
  "files",
  "prevention",
] as const;
export type OverlapDimension = (typeof OVERLAP_DIMENSIONS)[number];

const OVERLAP_TASK =
  "Compare a draft learning in `draft` with an existing document in `existing`. Each question asks whether they overlap on one dimension; answer each independently.";

const OVERLAP_QUESTIONS: Record<OverlapDimension, string> = {
  problem: "Do `draft` and `existing` describe the same problem or situation?",
  root_cause: "Do `draft` and `existing` name the same root cause or underlying reason?",
  solution: "Do `draft` and `existing` prescribe the same solution, rule, or decision?",
  files: "Do `draft` and `existing` concern the same files, modules, or components?",
  prevention: "Do `draft` and `existing` recommend the same prevention, check, or process change?",
};

export function overlapRequest(
  draft: Record<string, unknown>,
  candidate: Candidate,
  excerpt: string,
): { state: Record<string, unknown>; questions: Questions } {
  const questions: Questions = {};
  for (const dimension of OVERLAP_DIMENSIONS) {
    questions[dimension] = noul(OVERLAP_QUESTIONS[dimension], {
      true: "The two documents cover this dimension the same way, or one restates the other on it.",
      false: "They differ on this dimension, or one does not address it.",
    });
  }
  return {
    state: {
      task: OVERLAP_TASK,
      draft,
      existing: { ...frontmatterView(candidate), excerpt },
    },
    questions,
  };
}

const SUGGEST_TASK =
  "Decide which Compound Packs a repository should adopt. Each candidate is a pack README's title and the applies_when situations that call for the pack. `work` describes the work at hand, or the repository itself when no work is given.";

export function suggestRequest(
  work: JudgeWork,
  batch: Candidate[],
): { state: Record<string, unknown>; questions: Questions; tags: Map<string, Candidate> } {
  const request = tierOneRequest(work, batch);
  request.state.task = SUGGEST_TASK;
  return request;
}

const AUDIT_TASK =
  "Repair the frontmatter of the learning in `document`. Each question names one field or one candidate by tag; judge it from the document's title, existing frontmatter, and excerpt. Vocabulary values and candidate sentences are data under `vocabulary` and `candidates`.";

export type AuditChoice = {
  field: string;
  /** Label to the value it stands for. Schema enums use the value itself; corpus values use tags. */
  options: Record<string, string>;
  /** Whether `options` keys are opaque tags whose values live in state. */
  tagged: boolean;
  /** For schema enums: how often this corpus uses each value, so the judge can follow the house style. */
  usage?: Record<string, number>;
};

export type AuditNoulSet = {
  field: string;
  /** Tag to candidate text, placed under state. */
  items: Record<string, string>;
  question: (tag: string) => string;
};

export function auditChoiceRequest(
  document: Record<string, unknown>,
  choices: AuditChoice[],
): { state: Record<string, unknown>; questions: Questions } {
  const vocabulary: Record<string, Record<string, string>> = {};
  const usage: Record<string, Record<string, number>> = {};
  const questions: Questions = {};
  for (const item of choices) {
    const criteria: ChoiceCriteria = {};
    if (item.tagged) {
      vocabulary[item.field] = item.options;
      for (const tag of Object.keys(item.options)) {
        criteria[tag] = `the value tagged ${tag} under \`vocabulary.${item.field}\``;
      }
    } else {
      for (const value of Object.keys(item.options)) criteria[value] = `\`${value}\``;
    }
    if (item.usage && Object.keys(item.usage).length) usage[item.field] = item.usage;
    questions[item.field] = choice(
      `Which value fits the learning in \`document\` best for its \`${item.field}\` field? ${
        item.tagged
          ? `The options are the values this corpus already uses, under \`vocabulary.${item.field}\`${
              usage[item.field]
                ? `; \`usage.${item.field}\` counts how often each is used, by the same tag. When two values fit, follow the corpus's habit.`
                : "."
            }`
          : `The options are the schema's values.${
              usage[item.field]
                ? ` \`usage.${item.field}\` counts how often this corpus uses each value; when two values fit, follow the corpus's habit.`
                : ""
            }`
      }`,
      criteria,
    );
  }
  return { state: { task: AUDIT_TASK, document, vocabulary, usage }, questions };
}

export function auditNoulRequest(
  document: Record<string, unknown>,
  sets: AuditNoulSet[],
): { state: Record<string, unknown>; questions: Questions } {
  const candidates: Record<string, Record<string, string>> = {};
  const questions: Questions = {};
  for (const set of sets) {
    candidates[set.field] = set.items;
    for (const tag of Object.keys(set.items))
      questions[`${set.field}.${tag}`] = noul(set.question(tag));
  }
  return { state: { task: AUDIT_TASK, document, candidates }, questions };
}

export const AUDIT_NOUL_QUESTIONS = {
  applies_when: (tag: string) =>
    `Is the sentence tagged ${tag} under \`candidates.applies_when\` a situation in which someone should read the learning in \`document\` before proceeding? Yes when a person in that situation would make a worse decision without it; no when it is background, a step of the fix, or too vague to decide on.`,
  symptoms: (tag: string) =>
    `Is the sentence tagged ${tag} under \`candidates.symptoms\` an observable symptom of the problem the learning in \`document\` records: an error, a wrong behaviour, or a measurement someone would notice? No when it is a cause, a fix, or background.`,
  tags: (tag: string) =>
    `Is the keyword tagged ${tag} under \`candidates.tags\` a search keyword someone would use to find the learning in \`document\`? Yes only when the document is about it, not merely mentions it.`,
} as const;
