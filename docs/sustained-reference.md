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
