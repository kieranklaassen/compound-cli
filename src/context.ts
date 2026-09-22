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
  /** One yes/no question on a TTY; callers check `isTTY` first. */
  confirm: (question: string) => Promise<boolean>;
};

export function processContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => text(process.stdin),
    isTTY: Boolean(process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}
