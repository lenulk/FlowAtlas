# FlowAtlas project rules

- Keep project source, documentation, test reports and UI evidence in this folder.
- Run automated tests with `node scripts/run-tests.mjs` (or `npm test` when npm works), including focused regression runs by passing test paths. The runner saves TAP/JSON in `reports/tests/` and appends `docs/TEST-RUNS.md` on both success and failure.
- Record manual tests and tool failures in `docs/TEST-RUNS.md` immediately after each check. Analyze the symptom, cause, fix, verification and remaining risk in `docs/QUALITY.md`.
- Fix one principal issue per repair round. Demonstrate a newly found bug with a regression test where practical, then verify the fix and affected behavior.
- Run `node scripts/run-tests.mjs scripts/source-check.mjs` separately when source serving changes. It creates and deletes a disposable source file; do not run other snapshot tests concurrently with it.
- Use evidence labels honestly. Passing automated tests does not prove external-app integration, production readiness or user value. Record unfinished milestones in `PLAN.md`.
