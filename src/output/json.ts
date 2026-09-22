import type { FindResult } from "../find/result.ts";
import type { WorkState } from "../input/work-state.ts";

/** The public state view: every channel as normalized, without the draft's full body. */
export function publicState(state: WorkState): Record<string, unknown> {
  const { doc, plan, ...rest } = state;
  return {
    ...rest,
    plan: plan
      ? {
          path: plan.path,
          title: plan.title,
          topic: plan.topic,
          summary: plan.summary,
          requirements: plan.requirements,
          decisions: plan.decisions,
          text_chars: plan.text_chars,
          text_truncated: plan.text_truncated,
        }
      : null,
    doc: doc
      ? {
          path: doc.path,
          title: doc.title,
          applies_when: doc.applies_when,
          tags: doc.tags,
          excerpt: doc.excerpt,
        }
      : null,
  };
}

export function renderJson(result: FindResult): string {
  return `${JSON.stringify({ ...result, state: publicState(result.state) }, null, 2)}\n`;
}
