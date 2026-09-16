# Changelog

All notable changes will be documented here. The project follows Semantic Versioning after `1.0`; `0.x` releases may contain API changes documented in release notes.

## 0.1.0 - Unreleased

- Introduced framework-neutral Page, Thread, state, projection, directive, and trace contracts.
- Added deterministic routing, historical Page recovery, global multi-fidelity context compilation, and Thread archiving.
- Added heuristic and adapter-driven state extraction, summaries, embeddings, and bounded hybrid orchestration.
- Added OpenAI Realtime WebRTC, telemetry, provider-history management, client-secret, Responses, embedding, and SIP helpers.
- Added memory and PostgreSQL/pgvector persistence, React bindings, and the Next.js live laboratory.
- Added Supabase Auth/RLS persistence, normalized ownership-safe mappings, and pgvector RPC retrieval.
- Moved model-backed summary/embedding enrichment off the response-critical path and bounded optional realtime adapter waits.
- Added abort propagation, background state extraction, ordered/backpressured WebRTC events, reconnects, smoothed telemetry, and transport latency metrics.
- Added bounded concurrent reads, batch persistence, diversity projection, and leased durable PostgreSQL/Supabase enrichment jobs.
- Added guarded npm release tooling, CI, coverage gates, security controls, and open-source project documentation.
- Added a server-side OpenAI SIP sideband runtime with context-before-response ordering, tool execution, reconnects, provider-history control, and call token/duration limits.
- Added the `@llmovoice/twilio` Voice/SIP/SMS adapter with signed webhooks, idempotency, inbound and outbound calls, SMS replies and delivery callbacks, opt-out hooks, and Runtime persistence.
- Added `@llmovoice/providers` with OpenAI-compatible Mainland China text/embedding adapters for eight providers and server-side realtime voice profiles for Qwen, GLM, Baidu, and MiniMax.
