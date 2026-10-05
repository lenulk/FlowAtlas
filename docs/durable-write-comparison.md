# Isolated durable write experiment

Run `node scripts/run-tests.mjs scripts/benchmark-durable-write.mjs` and `node scripts/run-tests.mjs scripts/durable-write-format-check.mjs`. These are QA experiments, not a production journal or a supported storage format.

The fixture generates1,051 synthetic normalized HTTP traces through the existing in-memory ingestion path, then adds CLIENT spans to64 retained traces in two32-item commits. Each commit captures graph values immediately; later updates cannot rewrite earlier fixture history. Every condition uses the same35 states and the same shared frozen source-file map. Two cases contain1or64 synthetic source hashes. History is100; three rounds rotate the order of three conditions,18 conditions total.

| Condition | Timed work | Work excluded from timing |
| --- | --- | --- |
| production-snapshot | Existing JsonActionStore.save, including validation, serialization, open/write/fsync/close/replace | Fixture generation, store initialization and reopening |
| raw-snapshot | Preencoded identical storageVersion1state bytes, exclusive temporary file, write/fsync/close/production replacement helper | Validation, encoding, locking and reopening |
| raw-journal | Preencoded delta records, append and realfsync after every commit | Delta computation, framing/checksum, graph validation, locking, replay, compaction and migration |

Compare raw-snapshot with raw-journal to study these file operations. Comparing the journal's raw time directly with production-snapshot is not a supported backend speed comparison: substantial work and guarantees are absent from the experimental journal. Every condition performs35 realfsync calls. This experiment has no SDK, exporter, application requestp95 or shutdown deadline. Its report declares `performanceAcceptance.met=null` and must not replace the ordinary HTTP workload or pilot.

Both snapshot conditions verify final bytes exactly and reproduce100 retained graphs after reopen. Experimental journal replay verifies35 framed records, sequence/order, checksum and final exact graph values. The parser rejects incomplete/corrupt records rather than silently discarding data. Its record checks cover IDs/change counts/order, not the production store's full graph/source validation. `durable-write-format-check.mjs` exercises every incomplete prefix, checksum corruption, length bounds, sequence gaps/duplicates, update order and eviction. These are buffer-level checks, not a power-loss/process-crash or migration guarantee.

In the final local6October2026 measurement, each1-file case encoded6,371,360snapshot bytes versus2,181,529journal bytes; each64-file case encoded25,359,776 versus8,423,299. The journal writes roughly one-third as many bytes but retains the whole experimental log: final file2,181,529/8,423,299bytes versus snapshot241,908/801,708bytes. Compaction and its cost remain unimplemented; replay retention alone does not bound disk growth. This evidence does not justify adopting an unbounded append log.

Reports bind core source, experiment/format hashes, fixture digests, runtime, timings, byte accounting and reopen outcomes. Raw write counts use actual write return values; production byte totals are derived from exact encoded states, with final bytes verified separately. Internal production timing is reported separately; its raw stage field is null. Conditions delete only their canonical owned workspace after files/store close and lock removal; failures retain sanitized codes and relative paths.

An initial experimental report was invalid because fixture references allowed future updates to rewrite history. The failing regression and raw report are retained in TEST-RUNS/QUALITY; they cannot be used as benchmark evidence. See [durable drain ADR](adr-durable-drain.md) for adoption constraints. Before a backend change, establish bounded compaction, crash/corruption handling, acknowledgement/lock semantics, migration and rollback, then test matched HTTP performance and sustained load.
