# Bounded SDK capture policy

Status: development policy, 1 October 2026. Stable-load and performance acceptance remain open.

## Evidence

The unchanged coalesced 3-round fixture produces 1,051 spans per traced condition. CI revision2f40612 Ubuntu24 round3 reported overflow635 and timeout64 with the256-span buffer/300ms upload deadline; the other rounds captured all spans using33 batches each. The local default regression also persisted six CJS spans but acknowledged five, with timeout1 and no rejection/overflow. These are measured buffer/acknowledgement limits; the underlying pause source is unknown. An unacknowledged span can already be persisted.

## Decision

Use a default and maximum queue plus in-flight capacity of2,048 normalized spans and a default per-upload deadline of1,000ms (already the prior allowed maximum). Retain two upload slots, at most32 spans per batch,20ms partial-batch scheduling and900ms shutdown drain. Callbacks remain prompt and application requests do not await collector delivery. There are no metadata or business retries. Schemas, body limits, authorization, redaction and history retention stay as before.

This permits the entire known1,051-span burst to enter the bounded buffer while delivery pauses, with greater potential memory use and residence time. It does not promise lossless sustained traffic or a fixed resident-memory size; only the object count and active batch bodies are bounded. A collector that stays stalled still fills the queue or hits deadlines. Shutdown closes intake and may abort at900ms before the1,000ms upload deadline, counting remaining work as shutdown drops. No unbounded drain or delayed app response is introduced.

## Verification and alternatives

Controlled3,000-span stalled-collector test checks immediate callback,2,048 admitted,952 overflow, bounded shutdown accounting for the admitted spans, zero pending work and rejected oversized settings. Focused SDK/atomic contracts20/20 (2026-10-01T14-04-02-178Z) passed. Unchanged unprofiled fixture1/1 (14-04-43-130Z) acknowledged all3,153 spans with correct business results; performance FAILED (+16.336% aggregatep95 versus10%). Exact hosted/VM and sustained-load gates remain required. Existing failed runs are retained; neither acceptance criteria nor workload was relaxed.

Keeping256/300 retains the measured failure at the known workload. Unbounded buffering/retries would permit uncontrolled memory/drain and are rejected. More upload slots or a storage/backend redesign requires separate evidence. Reverting constructor defaults/cap to256/300 restores the prior policy without a schema migration and can reintroduce the known capture limits; stop the inspector before changing tool code and rerun the same gates.
