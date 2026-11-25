# Performance audit — 2026-11-25

Audited fresh `main` at `880a4aa2fe29d4efce7815f65e6592f34dc3276f`.
This active fork serves a local Express configuration/status UI on port 7432.
No printer, cloud account, installer, or service was contacted or started.

## Verified startup stall

`runBridge` awaits the initial cloud heartbeat before entering the monitoring
loop. Unlike regular status pushes, this request had no deadline. A stalled
request therefore prevented polling and delayed observing cancellation.

The startup fetch now uses the existing status-push policy:
`AbortSignal.timeout(10_000)`. Payloads, authentication, retry behavior and the
existing error handling are unchanged. A slow initial request now follows the
existing error path instead of occupying startup indefinitely.

The offline regression executes the production TypeScript module with I/O
stubbed. Before the change, 1/2 tests passed: the stalled-request test observed
zero configured deadlines. After the change, 2/2 pass and the recorded deadline
is 10,000 ms. The test also rejects the request and verifies error reporting and
cancellation without contacting a printer. A second test checks the successful
heartbeat payload and state. These are deterministic configuration/control-flow
measurements, not measured network latency or production throughput gains.

Run with Node 24+ (for built-in TypeScript stripping):

```sh
node --test tests/bridge-startup.test.mjs
```

`npm ci --ignore-scripts`, `npm run build`, `npx --no-install tsc --noEmit` and
`git diff --check` pass. Runtime still targets Node 18; only the standalone
regression harness uses Node 24. No package dependencies changed.

## Coverage and remaining constraints

- Reviewed local UI/server, monitoring loop, event log and printer/cloud adapter
  paths. The UI reads cached state; per-printer event history is bounded to 30.
  The status page reloads every eight seconds. Without a measured UI bottleneck,
  adding a frontend framework, caching layer or streaming API is unjustified.
- Monitoring is serial per printer, with existing backoff and bounded normal
  status requests. The patch does not increase downstream concurrency.
- Large printer-file downloads and real adapter latencies need representative
  files and simulated device endpoints before selecting memory/transfer limits.
  No arbitrary file-size cap or hardware behavior change was introduced.
- No production latency percentiles, concurrent-user throughput, memory profile,
  cold/warm cache baseline or Core Web Vitals were available. The bundle builds
  to approximately 2.4 MB; this is the Node server bundle, not browser payload.
- GitHub issue creation returned HTTP 410 because Issues are disabled on this
  fork. The finding is recorded here and in the draft PR; repository settings
  were not changed. Upstream install links were inspected, not executed.
