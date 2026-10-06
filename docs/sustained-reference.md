# Sustained reference workload

This owned synthetic HTTP app runs 20 workers continuously against actual OpenTelemetry SDK/exporter and the production JSON collector. Each worker checks the exact status/body and its own monotonically increasing request sequence. The collector checks every committed graph and independently models its bounded retention, then closes/reopens the durable store with byte-identical graph JSON.

Before measurement, limits are fixed in `scripts/sustained-reference-check.mjs`: 512 MiB max RSS each for target and combined driver/collector, state file at most64 MiB, history100, buffered spans2048, in-flight spans64 and upload slots2. The reference responds after100ms. These are reference test limits, not a production sizing recommendation. Numeric peak observers do not retain an unbounded list of requests or trace IDs. Unique trace identities are checked within the retained window; this does not prove every historical trace was unique. State size is checked after successful commits; transient files and total filesystem usage are not assessed.

Run the full30-minute condition separately from other local test workloads:

```powershell
$env:FLOWATLAS_TEST_PURPOSE='Full 20-worker 30-minute synthetic reference, actual SDK and durable collector'
Remove-Item Env:FLOWATLAS_SUSTAINED_DURATION_MS -ErrorAction SilentlyContinue
Remove-Item Env:FLOWATLAS_SUSTAINED_FAULT -ErrorAction SilentlyContinue
node scripts/run-tests.mjs scripts/sustained-reference-check.mjs
```

A separately labelled smoke run uses `FLOWATLAS_SUSTAINED_DURATION_MS=4000`; it always has sustained acceptance `met=null`. CI runs this smoke and a controlled409 business-response negative guard, preserving the inner failed runner/report/workspace while verifying SDK accounting and owned teardown. Full30-minute acceptance is assessed only when the complete requested duration ran, all responses/capture/resource/reload checks passed and cleanup succeeded. Every run has performance acceptance `met=null`: there is no paired latency baseline. No browser/business handler mapping, real business app, pilot user or production throughput is validated here.

Full Windows run on675fafa (2026-10-06T10-57-30-677Z) failed after264979.849ms:48078 correct business responses,48059 delivered/19 dropped, resources within declared bounds. Owned processes closed; failed workspace retained. The full30-minute gate is not passed. Drop-reason/storage diagnostics and durable reload after failed validation are the next work; this report does not prove the cause of the19 losses.

Failure reports also retain allowlisted drop/rejection counters and exporter/storage timing, plus bounded fixed-vocabulary storage errors. Failed validation still closes and reopens the accepted durable checkpoint with exact in-memory equality; the original failure and workspace remain. A controlled503 collector rejection guard verifies drop classification without changing business responses. Timing is enabled only for the owned QA process/collector. The old675fafa loss cause remains unknown; retrospective readability of its100 retained graphs does not restore19 lost spans.

Full diagnostic result on clean0daabf0 (2026-10-06T11-13-22-188Z): PASS for this reference condition only. The20 HTTP workers ran1800100.516ms and produced328763 correct responses, actual SDK spans, accepted spans and acknowledged spans; zero invalid/dropped/queued/in-flight. The100 retained graphs reopened with exact JSON equality. Owned child/collector closed and the successful workspace was removed. Maximum RSS: driver+collector211144704 bytes / target206651392 bytes; buffer40/in-flight40/slots2; state-file peak187030 bytes. Store25615 saves/0failures/maxsync127.713ms; exporter25615 acknowledged batches/shutdown6ms/no deadline. Exact source audit verifies98 candidate program files.

This does not close the earlier675fafa19-span loss after4m25s, whose cause remains unknown. It does not validate20 business actions, browser correlation, real business-app/user pilot, production throughput or paired latency acceptance. Hosted0daabf0 push passed four channels, but PR Ubuntu22 still failed independent browser send-message with correct business200 and incomplete metadata; the failure is retained. Paired performance still fails in every audited channel. See HANDOFF/QUALITY for next metadata-phase diagnostics and outstanding gates.
