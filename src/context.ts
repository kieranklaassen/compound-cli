import { text } from "node:stream/consumers";

export type Env = Record<string, string | undefined>;

export type Context = {
  cwd: string;
  env: Env;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  isTTY: boolean;
};

export function processContext(): Context {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => text(process.stdin),
    isTTY: Boolean(process.stdout.isTTY),
  };
}
