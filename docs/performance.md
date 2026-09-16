# Performance model

llmovoice keeps model enrichment outside the first-response path by default. Heuristic state is available immediately; optional model state extraction runs in the background. Set `stateExtractionMode: "blocking"` only when the first response depends on extracted state.

## Realtime path

- `prepareTurnBudgetMs` defaults to 250 ms. Blocking state extraction, routing embedding, ContextSources, and optional reasoning share this one abort deadline instead of consuming their individual timeouts serially. Deterministic routing, compilation, and safety controls still complete if the budget expires.
- Embedding routing has a 250 ms default deadline and falls back to lexical/recency scoring.
- External context sources run concurrently with bounded database reads and have a 350 ms default deadline.
- Optional orchestration reasoning has a 350 ms deadline and falls back to deterministic controls.
- Adapter deadlines propagate `AbortSignal`, so OpenAI fetches and cooperative application sources stop work after fallback.
- Provider events execute in arrival order. High-frequency speech/audio/transcript deltas do not trigger full persistent snapshots.
- WebRTC telemetry uses interval packet deltas, EWMA smoothing, material-change publication, and an overlap guard.
- The data channel is open before the client reports `connected`; buffered events and bytes are bounded.

## Data path

- Runtime snapshots load Pages, Threads, and traces concurrently with configurable limits.
- Router/compiler queries request bounded recent windows rather than reading complete user history.
- Vector and recent-history reads run concurrently.
- PostgreSQL uses JSONB recordset batch upserts for Pages, Threads, and traces.
- Supabase uses bulk Page/trace upserts and bounded PostgREST queries.
- Context candidates use diversity ranking and near-duplicate removal to reduce prompt tokens.
- PostgreSQL/Supabase enrichment workers use atomic leases, `SKIP LOCKED`, retries, and idempotent Page job IDs.

## Measurement

Every `PreparedTurn.timing` reports total runtime latency, configured budget, and whether the budget was exceeded. `RealtimeClientSnapshot.performance` reports connection setup, last turn preparation, first-audio latency, reconnect attempts, telemetry samples, and outbound queue/drop counts. Measure P50/P95 in the deployment region because browser, provider, database, and application-source latency dominate local CPU time.

Run the deterministic in-memory benchmark after building packages:

```bash
make benchmark
```

Use real-key browser tests for end-to-end TTFA; the local benchmark measures runtime/compiler/store overhead only.
