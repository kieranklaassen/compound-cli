import { resolve } from "node:path";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

export type CliResult = { code: number; stdout: string; stderr: string };

/**
 * Spawn the CLI as a subprocess with a controlled environment. The key is
 * stripped unless the caller passes one, so tests prove behavior without it.
 */
export async function runCli(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string; stdin?: string } = {},
): Promise<CliResult> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "/tmp",
    // Any accidental network call fails fast instead of reaching TypeSafe.
    TYPESAFE_BASE_URL: "http://127.0.0.1:9",
    ...options.env,
  };
  const proc = Bun.spawn(["bun", "run", BIN, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
