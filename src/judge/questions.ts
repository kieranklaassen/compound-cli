import { type ChoiceCriteria, choice, noul, type Questions } from "@typesafe-ai/sdk";
import type { Candidate } from "../corpus/candidate.ts";
import type { Section } from "../find/sections.ts";

/**
 * Every question the CLI asks Jev, in one place. Wording follows jegrep's lean
 * form: criteria are stated once in the state and each question refers to the
 * candidate's tag. Candidate text is always data under `state`, never part of
 * an instruction (plan KTD19).
 */

export type JudgeWork = Record<string, unknown>;

export function candidateTag(index: number): string {
  return `c${String(index).padStart(3, "0")}`;
}

export function sectionTag(index: number): string {
  return `s${String(index).padStart(2, "0")}`;
}

const TIER_ONE_TASK =
  "Decide which recorded learnings and pack rules apply to the work described in `work`. Each candidate is judged from its frontmatter only: its title, the applies_when situations its author wrote, tags, module, problem type, component, and symptoms.";

const APPLIES_CRITERIA = {
  yes: "The candidate's situation, problem, rule, or decision is one this work is in or will meet, so the person doing the work should read it before proceeding.",
  no: "The candidate concerns a different situation, component, or kind of problem, or shares only vocabulary with the work without bearing on it.",
};

const ADOPT_CRITERIA = {
  yes: "The pack's applies_when names a situation this work is in, so its rules would be worth consulting for this work.",
  no: "The pack is about a different domain, person, or kind of decision than this work involves.",
};

export function frontmatterView(candidate: Candidate): Record<string, unknown> {
  const fm = candidate.frontmatter;
  const view: Record<string, unknown> = {
    path: candidate.path,
    kind:
      candidate.kind === "solution"
        ? "learning"
        : candidate.kind === "pack_rule"
          ? "pack rule"
          : "pack",
    title: candidate.title,
  };
  if (candidate.packId) view.pack = candidate.packId;
  if (candidate.appliesWhen.length) view.applies_when = candidate.appliesWhen;
  if (candidate.tags.length) view.tags = candidate.tags;
  for (const key of ["module", "problem_type", "component", "record_type"] as const) {
    const value = fm[key];
    if (typeof value === "string" && value.trim()) view[key] = value.trim();
  }
  const symptoms = fm.symptoms;
  if (Array.isArray(symptoms) && symptoms.length)
    view.symptoms = symptoms.filter((s) => typeof s === "string");
  return view;
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
    candidates[tag] = frontmatterView(candidate);
    const title = JSON.stringify(candidate.title);
    questions[tag] =
      candidate.kind === "pack_candidate"
        ? noul(
            `Should the pack tagged ${tag} (${title}) be adopted for the work in \`work\`? Its \`applies_when\` lists the situations that call for the pack; apply \`criteria.adopt\`.`,
          )
        : noul(
            `Does the item tagged ${tag} (${title}) apply to the work in \`work\`? Judge by its \`applies_when\`, title, tags, module, and problem type; apply \`criteria.applies\`.`,
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
    where[tag] = section.heading;
  });
  const questions: Questions = {
    relevant: noul(
      `Does the document in \`document\` (${JSON.stringify(candidate.title)}) apply to the work in \`work\`?`,
      {
        true: "The document's problem, rule, or decision bears on this work: knowing it would change what the person does or checks.",
        false:
          "The document concerns a different situation, or shares only vocabulary with the work; knowing it would not change the work.",
      },
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
