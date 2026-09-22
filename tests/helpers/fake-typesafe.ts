/**
 * An HTTP stand-in for TypeSafe's system-one endpoint, for subprocess tests
 * that need a judge without a key, a network, or a recording. Every Noul gets
 * the same probability, every Score the same level, every Choice its first
 * option, so tests assert on plumbing (what was judged, what was reported),
 * never on relevance.
 */
export type FakeTypeSafe = {
  url: string;
  requests: () => number;
  stop: () => void;
};

type Question = { type: string; criteria?: unknown };

export function startFakeTypeSafe(
  options: { noul?: number; scoreLevel?: number } = {},
): FakeTypeSafe {
  const noulValue = options.noul ?? 0.1;
  const level = options.scoreLevel ?? 0;
  let count = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      count++;
      const body = (await request.json()) as { questions: Record<string, Question> };
      const answers: Record<string, unknown> = {};
      for (const [key, question] of Object.entries(body.questions)) {
        if (question.type === "noul") {
          answers[key] = { type: "noul", noul: noulValue };
        } else if (question.type === "score") {
          const criteria = (question.criteria as string[]) ?? [];
          const legend: Record<string, string> = {};
          const probabilities: Record<string, number> = {};
          criteria.forEach((text, index) => {
            legend[String(index)] = text;
            probabilities[String(index)] = index === level ? 1 : 0;
          });
          answers[key] = { type: "score", score: level, confidence: 1, legend, probabilities };
        } else {
          const keys = Object.keys((question.criteria as Record<string, string>) ?? { a: "" });
          const probabilities: Record<string, number> = {};
          for (const k of keys) probabilities[k] = k === keys[0] ? 1 : 0;
          answers[key] = { type: "choice", choice: keys[0], confidence: 1, probabilities };
        }
      }
      const n = Object.keys(answers).length;
      return Response.json({
        model: "jev-fake",
        answers,
        usage: { input_tokens: 100 + n * 10, output_tokens: n },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: () => count,
    stop: () => server.stop(true),
  };
}
