export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  NOT_CONFIGURED: 3,
  MISSING_CORPUS: 4,
  JUDGE_FAILURE: 5,
  FINDINGS: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_CODE_DOCS: ReadonlyArray<{ code: ExitCode; name: string; meaning: string }> = [
  { code: EXIT.OK, name: "ok", meaning: "success, with hits or with nothing_relevant" },
  { code: EXIT.INTERNAL, name: "internal", meaning: "unexpected internal error" },
  { code: EXIT.USAGE, name: "usage", meaning: "bad arguments or missing input" },
  { code: EXIT.NOT_CONFIGURED, name: "not-configured", meaning: "TYPESAFE_API_KEY is not set" },
  {
    code: EXIT.MISSING_CORPUS,
    name: "missing-corpus",
    meaning: "no <root>/solutions/ directory and no declared packs",
  },
  {
    code: EXIT.JUDGE_FAILURE,
    name: "judge-failure",
    meaning: "TypeSafe request failed after retries, or a cassette replay missed",
  },
  {
    code: EXIT.FINDINGS,
    name: "findings",
    meaning: "audit found files that fail (errors, or warnings under --strict)",
  },
];
