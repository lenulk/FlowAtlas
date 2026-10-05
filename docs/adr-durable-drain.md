# Durable drain under a bounded exporter deadline

Status: investigation decision, round65,5October2026. This records a diagnostic and the prerequisites for a repair. It does not approve a backend, deadline or acknowledgement change.

## Evidence

Exactceddc0f PR37339435370 lost635/891 acknowledgements in simulated disk bursts and795 in an independent disk condition within the negative guard. Exporter shutdown fired around902ms; measured store sync consumed915/944/860ms. Other conditions and the separate push run passed. These are intermittent hosted component failures, not a business pilot or proof that prior827 losses have the same cause.

The new controlled reproduction adds120ms immediately before each realfsync on owned component temporary state files. Production exporter/collector/store bytes remain unchanged, exporter remains in its separate process, transport/memory are controls, and real persistence/reopen still run. In the first local reproduction all three disk rounds acknowledged192 and reported859shutdown drops; each retained store reopened exactly. This establishes that collector sync delay can cause bounded exporter shutdown losses in this simulation. It does not establish actual disk speed, application overhead, lossless persistence or causality for every historical failure. An upload aborted before acknowledgement may have been persisted by the collector.

Exact6d08a53 hosted verification: PR37343310494 passed4/4; push37343288536 passed3/4 because a separate uninstrumented Linux24 disk condition lost859 acknowledgements with sync1138ms. Controlled scope/reproduction passed2/2 all8jobs and24diskconditions deliberately lost827or859 with retained exact reload. Audits16-52-49-069Z/16-52-55-491Z bound112runner reports to81exactGit files. The ordinary component failure remains open; matching the historical827 count does not prove that historical event's cause. All8ordinary HTTPperformance reports failed their unchanged criterion.

## Decision

Retain current900ms shutdown,1000ms upload,2048capacity,two slots,batch32 and acknowledgement after existing write/fsync/rename for this round. Keep ordinary/component failures visible. The controlled inner capture check must fail, while the outer reproduction passes only when accounting,deadline,scope,realfsync,retained data and controls agree. Injection is an explicit QA preload, scoped to canonical reports/storage/collector-cost-* state temporary files. It is never loaded by the production CLI or ordinary benchmark.

Do not remove fsync, acknowledge before persistence or silently extend shutdown to obtain passing evidence. A fixed short drain and arbitrary slow durable writes cannot guarantee lossless bursts; a repair must state its workload and failure bound rather than promise that a backend alone removes every timeout.

## Alternatives and next experiment

- Keep snapshot storage: simpler existing recovery and rollback, but every request rewrites and syncs retained history. Capture can remain incomplete during slow writes.
- Append a bounded durable journal: potentially reduces serialization and rewritten bytes, but still incurs sync latency. Requires a measured comparison, batch framing/checksum, atomic visibility and crash recovery before adoption.
- Group commits: potentially reduces fsync calls; cannot acknowledge a group before durable completion. Needs explicit async request coordination, bounded buffering, orderly close and failure propagation. Current two exporter slots limit available coalescing.
- Longer or configurable drain: changes user-visible stop time and still cannot guarantee completion on arbitrary I/O stalls. Requires a separate lifecycle decision and independent stop-time tests; not approved here.
- Application-side durable retry/spool: can survive collector outages but adds disk cost and private metadata on the app side. Requires bounded retention/privacy/idempotency and restart semantics, not a hidden retry in tests.

Prioritize an isolated journal-versus-snapshot write/sync comparison with identical data and separately labeled controls. Also measure SDK-only cost separately; do not subtract component burst timings from application requestp95. Any backend proposal must specify:

1. Batch atomicity and when memory/ack becomes visible; failed write/sync must preserve previously acknowledged data.
2. Torn append, truncation, checksum failure, corruption and process termination recovery; never silently accept a damaged acknowledged prefix.
3. Writer lock ownership, maximum bytes,history100,compaction and failure during compaction, backup and cleanup.
4. Existing storageVersion1migration,exact snapshot identities,upgrade/downgrade compatibility and a tested rollback path.
5. Privacy of exports/reports, idempotent replay after an uncertain acknowledgement and retained evidence when drain fails.
6. Ordinary matched HTTP workload/performance criterion, sustained load and Windows/Linux Node22/24 checks. Synthetic fault controls do not replace real-app pilot/user trials.

Rollback of this diagnostic: remove its CI step and two QA scripts; no storage migration or production configuration change is needed. Keep all failed reports and historical status.
