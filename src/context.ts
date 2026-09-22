import { createInterface } from "node:readline/promises";
import { text } from "node:stream/consumers";

export type Env = Record<string, string | undefined>;

export type Context = {
  cwd: string;
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  isTTY: boolean;
  /** One yes/no question on the terminal; callers check `isTTY` (stdin and stdout) first. */
  confirm: (question: string) => Promise<boolean>;
};

export function processContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => text(process.stdin),
    // A prompt reads stdin; a piped stdin with a terminal stdout must not hang on a question.
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await Promise.race([
          rl.question(`${question} [y/N] `),
          new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
        ]);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}
