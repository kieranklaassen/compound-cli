import { EXIT, type ExitCode } from "./exit-codes.ts";

export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT.USAGE);
  }
}

export class NotConfiguredError extends CliError {
  constructor(variable: string) {
    super(
      `not configured: set ${variable} in the environment to use the TypeSafe judge`,
      EXIT.NOT_CONFIGURED,
    );
  }
}

export class MissingCorpusError extends CliError {
  constructor(root: string, packErrors: readonly string[] = []) {
    const detail = packErrors.length
      ? ` (declared packs failed to resolve: ${packErrors.join("; ")})`
      : "";
    super(
      `missing corpus: no learnings under ${root}/solutions/ and no resolvable packs${detail}`,
      EXIT.MISSING_CORPUS,
    );
  }
}

export class JudgeError extends CliError {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(`judge failure: ${message}`, EXIT.JUDGE_FAILURE, { cause: options?.cause });
    this.status = options?.status;
  }
}
