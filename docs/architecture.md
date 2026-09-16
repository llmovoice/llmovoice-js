# Architecture

## Runtime boundary

`LlmovoiceRuntime` is the top-level coordinator. It has two engines:

- Context engine: `PageBuilder → ThreadRouter → Retriever → ContextCompiler`.
- Control engine: `StateReducer → ControlOrchestrator → Directive`.

The runtime does not implement a speech model, telephony carrier, application memory system, tool executor, billing system, or authentication provider.

## Turn lifecycle

1. A transport emits canonical `ConversationEvent`s.
2. Final user input materializes an open `VoicePage`.
3. `ThreadRouter` appends the Page to matching Threads or spawns a new Thread.
4. `ContextCompiler` retrieves candidate Threads, Pages, and external context.
5. The compiler selects a fidelity for each candidate within the input budget.
6. `ControlOrchestrator` applies deterministic environment-first policies.
7. The provider adapter applies directives and starts model generation.
8. Final assistant output completes the same Page.
9. The completed Page is persisted immediately; configured summary and embedding adapters refresh Page and Thread representations on an ordered local queue or a leased durable PostgreSQL/Supabase queue. `waitForEnrichment()` provides a graceful-shutdown/testing barrier.

## Invariants

- A Page belongs to one user and one session.
- A Page sequence is unique inside a session.
- A Page can belong to multiple Threads.
- Threads point to Pages and never duplicate audio/transcript payloads.
- Compiled input never exceeds `maxInputTokens - reservedOutputTokens`.
- Dropped candidates remain visible in the projection trace.
- Environment safety policy takes precedence over semantic and style preferences.
- Provider failures do not mutate completed historical Pages.
- A resumed session restores its last sequence and state before accepting a new turn.
- Standard provider credentials never enter Page, Thread, state, or trace payloads.

## Routing

The default router combines:

- lexical containment/similarity;
- optional embedding cosine similarity;
- recency decay;
- active-thread locality;
- explicit application-provided Thread hints.

When pgvector search is available, the router can recover related Pages from inactive historical Threads into a newly spawned Thread. Applications with strong task identifiers should still provide Thread hints instead of relying only on semantic routing.

## Projection

Each candidate exposes available fidelity options. The compiler begins with the highest useful representation, then globally chooses the least damaging fidelity degradation until both token and optional USD budgets fit. Every retained, degraded, and dropped candidate is recorded in the projection trace.

Audio is preferred only when the query or state needs acoustic/style information. Transcript is normally preferred for semantic facts. This avoids assuming that raw audio is universally more useful than text.

## Control

Hard realtime policy is deterministic. Actual or application-supplied network state selects pause/resume and VAD silence directives without an LLM call. An optional `OrchestrationReasoner` may propose pacing, model instructions, tools, and application actions, but all proposals are bounded and compiled through the deterministic environment-first layer. Timeout or model failure cannot suppress the deterministic directives.

The OpenAI browser adapter applies provider-native pace, VAD, playback, response-cancel, and conversation-item deletion directives. Tool and application directives pass only through an application-provided `DirectiveExecutor`.

## Persistence

`MemoryContextStore` is intended for tests, examples, and short-lived processes. `PostgresContextStore` provides persistent idempotent storage and optional pgvector/HNSW similarity search. Queries include the user boundary, but production applications must still authorize that identity before calling the store and implement deletion, retention, encryption, and backup workflows.

## Failure containment

- Summary, embedding, extraction, and reasoning adapters are optional and have deterministic fallbacks.
- Slow state, routing-embedding, external-source, and orchestration adapters have bounded realtime waits; cleared timers do not linger after successful work.
- Optional realtime adapters share the session's `prepareTurnBudgetMs` abort deadline; an already-expired parent signal fails immediately.
- Context never exceeds the configured input budget, even when every candidate must be dropped.
- Archived Threads are excluded from future compilation.
- Old provider conversation items are removed only after durable Page state exists; selected audio-fidelity items stay provider-native.
- Provider credentials are accepted only by server helpers and are never part of public runtime state.

The in-memory store uses a process-local queue. `PostgresContextStore` and `SupabaseContextStore` implement the optional durable queue contract with atomic `FOR UPDATE SKIP LOCKED` claims, expiring leases, bounded retries, and idempotent job IDs. Passing either store to `createLlmovoice({ store })` enables durable enrichment automatically.

## Supabase profile

The checked-in Supabase migration normalizes `thread_pages`, enables pgvector/HNSW, adds leased enrichment jobs, and applies forced RLS to Pages, Threads, mappings, traces, and jobs. `@llmovoice/supabase` is bound to one authenticated user even when a service-role client is supplied. The standard PostgreSQL adapter remains available for trusted services that do not use Supabase Data API/Auth.
