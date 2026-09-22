import { describe, expect, test } from "bun:test";
import { EXIT, EXIT_CODE_DOCS } from "../src/exit-codes.ts";
import { runCli } from "./helpers/run-cli.ts";

describe("compound cli", () => {
  test("--help lists every command and exit code", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(EXIT.OK);
    for (const command of ["find", "packs", "bench", "doctor"]) {
      expect(result.stdout).toContain(`  ${command}`);
    }
    for (const entry of EXIT_CODE_DOCS) {
      expect(result.stdout).toContain(`  ${entry.code}  ${entry.name}`);
    }
  });

  test("unknown command exits 2 with one usage line", async () => {
    const result = await runCli(["nonsense"]);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("unknown command");
  });

  test("find without a key exits 3 naming TYPESAFE_API_KEY before any network call", async () => {
    const result = await runCli(["find", "add retry with backoff"]);
    expect(result.code).toBe(EXIT.NOT_CONFIGURED);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TYPESAFE_API_KEY");
  });

  test("find without any input channel exits 2 naming the channels", async () => {
    const result = await runCli(["find"], { env: { TYPESAFE_API_KEY: "test-key" } });
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("--concept");
    expect(result.stderr).toContain("--diff");
  });

  test("find rejects --json with --compact", async () => {
    const result = await runCli(["find", "x", "--json", "--compact"]);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("mutually exclusive");
  });

  test("find rejects an out-of-range threshold", async () => {
    const result = await runCli(["find", "x", "--threshold", "1.5"]);
    expect(result.code).toBe(EXIT.USAGE);
    expect(result.stderr).toContain("--threshold");
  });

  test("find --help exits 0 and documents the channels", async () => {
    const result = await runCli(["find", "--help"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout).toContain("--concept");
    expect(result.stdout).toContain("--diff <file|->");
  });

  test("version prints the version", async () => {
    const result = await runCli(["version"]);
    expect(result.code).toBe(EXIT.OK);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
