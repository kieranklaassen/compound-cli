# Residual review findings

Branch `cursor/compound-cli-v1-fea0`, reviewed at commit `ef34ff8` by the correctness, security, reliability, testing, and adversarial reviewers (five in-process personas; no cross-model peer was available in the build environment, so the adversarial lens ran in-process). Forty-four findings were returned; thirty-one were applied in commit `ef34ff8` ("fix: apply code review findings"). The rest are recorded here with their tracker tickets.

## Residual Review Findings

- P2 `src/find/defaults.ts:13` Bench cassettes cannot see model drift behind the `jev-latest` alias. [#1](https://github.com/kieranklaassen/compound-cli/issues/1)
- P2 `src/judge/client.ts:55` No total judging deadline; the SDK retry policy has no total budget. Partially mitigated in `ef34ff8` by capping `maxRetryAfterMs` at the local backoff. Also covers P3 `src/corpus/git-cache.ts:111`, fallback fetch timeouts compounding across git calls. [#2](https://github.com/kieranklaassen/compound-cli/issues/2)
- P3 `src/commands/packs-suggest.ts:92` Untrusted pack text printed raw to the terminal. [#3](https://github.com/kieranklaassen/compound-cli/issues/3)
- Efficiency: tier-two pipelining, async git clones and `ls-remote`, reusing the workspace git cache for known sources. [#4](https://github.com/kieranklaassen/compound-cli/issues/4)
- Residual risks: `packs list` and `packs resolve` exit 0 on declaration errors; concurrent `packs add` is a read-modify-write; `id:` overrides are not sanitized. [#5](https://github.com/kieranklaassen/compound-cli/issues/5)
- Low `src/commands/packs-add.ts:52` The confirmation prompt bypasses `Context`, so it is not testable in-process. [#6](https://github.com/kieranklaassen/compound-cli/issues/6)

## Settled-decision conflicts

None. No finding contradicted a `session-settled` decision.

## Source run

Review artifacts were written under `/tmp/compound-engineering-1000/ce-code-review/20260922-021502-722a277e/` on the build machine and are not committed.
