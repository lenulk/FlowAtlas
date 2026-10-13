# QA exporter / durable pair comparison

Round83, 13 October 2026. This experiment compares the same production `LocalHttpSpanExporter` in a separate child process against the production collector and the round82 QA HTTP admission prototype. It does not mount the prototype in production or change the store format.

Run ordinary capture and the controlled failure guard separately:

```powershell
node scripts/run-tests.mjs scripts/benchmark-exporter-durable-pair.mjs
node scripts/run-tests.mjs scripts/exporter-durable-pair-guard.mjs
```

Each condition bursts 1051 synthetic SDK-shaped SERVER spans, not spans created by a real SDK/business application. Three paired rounds rotate production/QA order. Capacity2048, two upload slots, batch32, upload1000ms and shutdown900ms remain unchanged. Both collectors use real JsonActionStore write/fsync/rename, history100 and exact reload. An identical nonthrowing post-save observer tracks known synthetic trace IDs and the last saved state. This adds observation cost to both conditions. Order digests prove saved-state/reload consistency, not independent sender order.

The QA adapter accepts the exporter's original route and exact bearer token, then delegates to `/qa/ingest`; its fixed202 response and deep-clone staging differ from the production action-results response. This is an aggregate prototype comparison, not grouping-only isolation. Reports contain fixed numeric health/timing fields and source/script/prototype/fixture digests, not bearer tokens, raw URLs, bodies or errors.

## Local evidence

Windows Node24.19.0 final ordinary runner `2026-10-13T16-29-24-948Z` passed1/1: all six conditions acknowledged1051/dropped0/accepted1051, reloaded history100 exactly, confirmed child/server/store close, and removed only successful owned workspaces. Production used33 saves per condition; QA used17. Initial ordinary `16-26-57-887Z` also passed before explicit cleanup booleans were added; it is retained as history.

Controlled guard `2026-10-13T16-32-04-844Z` passed1/1 while its inner comparison `exporter-durable-pair-slow-2026-10-13T16-32-05-322Z.json` deliberately FAILED0/1. Every production condition acknowledged192/dropped859; every QA condition acknowledged320/dropped731. All drops were shutdown drops and all six reloads matched. The existing canonical-path QA preload delayed before each real fsync by120ms:42 actual injections, zero open descriptors. This is synthetic I/O delay, not a measurement of real disk speed.

The guard requires the original inner failure, unchanged accounting/deadlines, actual successful saves, accepted>=acknowledged, exact reload, closed worker/server/store, no writer lock, and retained failed workspaces. It saves the inner TAP/report before asserting guard success. A passing guard verifies the reproduction; it does not turn inner loss into passing capture. Production accepted256 with8 saves, QA accepted384 with6 saves in each controlled pair: both persisted64 more spans than the sender acknowledged. A delivery drop does not prove absence from disk.

Final main `2026-10-13T16-34-43-469Z` passed187/187 with the default two file workers and no skips; isolated source `16-36-10-553Z` passed1/1. All112 program-file hashes match the final main inventory. Production browser code did not change; no new Edge journey was run or claimed. Passing this condition does not close historical intermittent startup failures.

## Decision and limits

Keep the prototype QA-only. Fewer writes improve this controlled comparison but still do not drain1051 spans within900ms under120ms pre-fsync delay. Performance acceptance remains `met:null` for this experiment; the ordinary application HTTP p95 criterion remains unchanged and unresolved. Real SDK creation cost, shared host contention, crash recovery, intermittent CLI startup, historical losses and business pilot/user trials remain separate open work.

Next inspect source-matched hosted evidence and measure actual SDK/target cost against the existing paired application workload before choosing a production optimization. The existing HTTP benchmark already separates driver, collector and target processes; another process-isolation experiment would not address the refuted same-event-loop hypothesis.

Rollback removes these two QA scripts and their CI steps; no data migration or production configuration change is needed. Retain failed evidence.

## Round84: Node22 TAP marker repair (14 ตุลาคม 2026)

Hosted round83 source-matched audit covers push5a40465 and PR merge4cac158: eight artifacts, 264 runner reports, exact112 program hashes each. All main runs passed187 and all48 ordinary comparison conditions captured1051 spans without drops. All48 controlled conditions retained shutdown losses and verified reload; these remain synthetic evidence, not performance or pilot acceptance.

Node22 formats the preload exit marker as `# FLOWATLAS_SLOW_SYNC ...` in TAP; Node24 emits a bare line. The original guard matched only bare lines and failed exactly-one-marker on all four Node22 artifacts. The repair accepts those two precise forms with bounded input/line sizes, fixed numeric schema and duplicate rejection. It retains inner exit1, actual injected calls equal successful saves, zero open descriptors, shutdown accounting and reload assertions. Evidence now includes the parser digest. No production or preload bytes, deadline, retry or acceptance threshold changed.

Local focused tests5/5 and actual controlled guard1/1 passed on Node24.19.0. The inner comparison still FAILED0/1 as expected, with productionACK192/drop859 and QAACK320/drop731 in each pair, 42 actual120ms delays and verified reload. Hosted replacement Node22 execution remains to verify. Main/source final results and publication are in TEST-RUNS.md. Roll back the QA parser/guard/test changes if needed; no storage migration is involved.
