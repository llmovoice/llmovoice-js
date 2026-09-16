<p align="center">
  <img src="./docs/assets/llmovoice-icon.svg" width="88" height="88" alt="llmovoice waveform mark" />
</p>

<h1 align="center">llmovoice.js</h1>

<p align="center"><strong>CONVERSATIONS THAT KEEP MOVING.</strong></p>

<p align="center">
  Voice-native context orchestration for long-running realtime AI.<br />
  Scalable context. Natural turns. Robust sessions.
</p>

<p align="center">
  <a href="https://llmovoice.com">Website</a> ·
  <a href="./docs/getting-started.md">Getting started</a> ·
  <a href="./apps/demo">Live lab</a> ·
  <a href="./public/paper/llmovoice-04012026.pdf">Research paper</a>
</p>

> **v0.1.0 · production beta.** The runtime, storage adapters, OpenAI Realtime WebRTC path, live lab, tests, and release tooling are implemented. Read [Project status](#project-status) before operating a public service.

## Context is infrastructure

A short voice demo can keep its entire history in one model session. A useful long-running agent cannot: history grows, context gets expensive, topics return after interruptions, speaking style drifts, and network gaps can be mistaken for conversational turns.

`llmovoice.js` adds a provider-neutral context layer between realtime I/O and model inference. It turns each interaction into an inspectable **VoicePage**, groups related work into resumable **VoiceThreads**, compiles only the useful history under a hard budget, and emits deterministic control directives from content, style, and network state.

```text
Voice · text · phone · SMS
            │
            ▼
      LlmovoiceRuntime
      ├─ organize     VoicePages + VoiceThreads
      ├─ represent    audio + transcript + summary
      ├─ project      relevance + fidelity + hard budget
      └─ orchestrate  content + style + environment
            │
            ▼
 Model · storage · transport · application adapters
```

The result is context that stays bounded, explainable, portable, and recoverable across sessions.

## Start in two minutes

No database, Supabase project, or API key is required for the core runtime.

```bash
pnpm add @llmovoice/runtime
```

```ts
import { createLlmovoice } from "@llmovoice/runtime";

const runtime = createLlmovoice({
  compiler: {
    budget: { maxInputTokens: 10_000, reservedOutputTokens: 1_500 },
  },
});

const session = runtime.createSession({
  userId: "user_123",
  sessionId: "conversation_456",
});

const turn = await session.prepareTextTurn(
  "Back to the hotel search — it still needs to allow dogs.",
);

console.log(turn.routing);                  // Thread append or spawn
console.log(turn.context.rendered);         // Budgeted model context
console.log(turn.context.trace.decisions); // Why each item was kept or dropped
console.log(turn.orchestration.directives);// Pacing, pause, model, or app controls
```

This prepares context and controls; your model or transport adapter produces the response. For a real browser microphone conversation, follow the [OpenAI Realtime walkthrough](./docs/getting-started.md#3-add-a-realtime-browser-call).

## Try the live lab

Requirements: Node.js 22+ and pnpm.

```bash
git clone https://github.com/llmovoice/llmovoice-js.git
cd llmovoice-js
pnpm install
cp apps/demo/.env.example apps/demo/.env.local
```

Add a server-side OpenAI key to `apps/demo/.env.local`:

```env
OPENAI_API_KEY=sk-...
```

Then start the lab:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). You can make a real WebRTC microphone call, mix text into the same context, switch topics, inspect Pages and Threads, see projection decisions and cost, observe network-aware directives, and reconnect to a restored session. The standard API key stays on the server; the browser receives a short-lived client secret.

Supabase is optional. Without it, the lab uses in-memory storage. Add Supabase Auth and the checked-in migration when you want durable, user-isolated Pages, Threads, traces, pgvector retrieval, and reconnect-after-reload behavior.

**New here?** The [Getting started guide](./docs/getting-started.md) covers the memory-only runtime, Next.js token route, browser WebRTC client, React hooks, PostgreSQL, Supabase, application context, and production checklist in one path.

## What ships in v0.1.0

- Turn-level VoicePage creation, completion, interruption, and tracing.
- Topic-aware VoiceThread append, spawn, archive, explicit resume, and session restoration.
- Lexical, embedding, recency, active-thread, and application-hint retrieval signals.
- Budgeted `audio → transcript → summary → drop` projection with query-dependent fidelity and a complete decision trace.
- Content, speaking-style, and network state with deterministic environment-first policies.
- Abortable optional workers, a shared turn latency budget, bounded fallbacks, and durable enrichment queues.
- Memory, PostgreSQL/pgvector, and Supabase Auth/RLS stores.
- OpenAI Realtime WebRTC with server-minted client secrets, ordered events, backpressure, telemetry, reconnect, provider-history trimming, and directive execution.
- OpenAI Realtime SIP call control plus a server-side sideband Runtime for transcripts, compiled context, private tools, reconnects, and call limits.
- Mainland China text/embedding adapters for Qwen, GLM, Baidu, MiniMax, Doubao, Hunyuan, DeepSeek, and Kimi, plus realtime voice profiles for Qwen, GLM, Baidu, and MiniMax.
- Twilio Voice/SIP/SMS adapters with signed webhooks, idempotency, inbound/outbound delivery, status callbacks, opt-out hooks, and Runtime persistence.
- React subscriptions, a Next.js live lab, offline tests, credentialed E2E tests, benchmarks, and guarded release commands.

## Choose only what your application needs

| Package | Use it for |
| --- | --- |
| `@llmovoice/runtime` | Pages, Threads, routing, context compilation, policies, traces, and session lifecycle |
| `@llmovoice/core` | Framework-neutral types and adapter contracts |
| `@llmovoice/openai` | OpenAI Realtime WebRTC, server workers, and SIP call control |
| `@llmovoice/providers` | Mainland China text, embedding, and realtime voice provider adapters |
| `@llmovoice/twilio` | Twilio Voice/SIP routing, outbound calls, SMS, signed webhooks, and delivery status |
| `@llmovoice/react` | React subscriptions for runtime and Realtime state |
| `@llmovoice/postgres` | Trusted-server PostgreSQL persistence and optional pgvector retrieval |
| `@llmovoice/supabase` | Supabase Auth/RLS persistence, pgvector retrieval, and table-backed application context |
| `@llmovoice/cloud` | Managed Context Store, traces, usage, export, and deletion through llmovoice Cloud |

`llmovoice.js` is TypeScript and framework-neutral at its core. The included live lab uses Next.js, but the runtime does not require Next.js, React, OpenAI, or Supabase.

## Bring your own data and model

Storage is an adapter, not a platform requirement:

```text
MemoryContextStore        local examples and tests
PostgresContextStore      trusted server applications
SupabaseContextStore      browser + Supabase Auth/RLS applications
ContextStore              any other database or service
```

Application-owned profile, goal, preference, CRM, or domain memory enters through `ContextSource`. It participates in the same relevance and budget decisions without moving ownership of that data into llmovoice.

```text
Application memory ── ContextSource ─┐
VoicePages + VoiceThreads ────────────┼─ ContextCompiler ─ Model context
Realtime environment state ──────────┘
```

The default Supabase installation uses a dedicated `llmovoice` schema. A host may deploy the canonical schema under another safe namespace. Existing application tables should remain application-owned and be adapted through `ContextSource` or a custom `ContextStore`.

## Design boundary

`llmovoice.js` owns episodic conversation context and realtime control. Your application continues to own:

- identity, authorization, consent, retention, export, and deletion;
- model billing, rate limits, spend caps, and provider credentials;
- business memory, tools, navigation, product policy, and UI;
- carrier provisioning, webhook verification, recording disclosure, and regional telephony compliance.

Raw audio persistence is opt-in. The browser lab records transcripts and state but does not persist microphone audio.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Getting started](./docs/getting-started.md) | First install through a realtime, persistent application |
| [Architecture](./docs/architecture.md) | Lifecycle, invariants, routing, projection, control, and failure containment |
| [OpenAI Realtime](./docs/openai-realtime.md) | Authentication, WebRTC event flow, turn control, telemetry, and SIP boundary |
| [Twilio Voice and SMS](./docs/telephony.md) | Phone-number routing, SIP sideband Runtime, SMS, identity, limits, and deployment |
| [Mainland China providers](./docs/mainland-china.md) | Qwen, GLM, Baidu, MiniMax, Doubao, Hunyuan, DeepSeek, and Kimi integration |
| [Supabase / CoachGPT integration](./docs/coachgpt-integration.md) | Concrete host-application identity, storage, and ContextSource boundary |
| [Performance](./docs/performance.md) | Turn budgets, cancellation, query bounds, backpressure, and benchmarks |
| [Contributing](./CONTRIBUTING.md) | Local checks and contribution expectations |
| [Security](./SECURITY.md) | Vulnerability reporting and deployment responsibilities |

## Development and release

```bash
pnpm typecheck
pnpm test:coverage
pnpm test:e2e
pnpm test:telephony
pnpm test:providers
pnpm build
```

With Supabase and OpenAI test credentials configured, `make test-e2e-real` covers login, WebRTC connection, live text, topic switching, disconnect/reconnect, Thread restoration, and logout.

Release commands are guarded and dry-run first:

```bash
make check
make pack
make publish-dry-run

# Explicit confirmation is required for side effects.
make push CONFIRM=push
make publish CONFIRM=publish
```

See `make help` for all commands and overrides.

## Project status

`0.1.0` is a production-beta SDK: the core architecture and one real browser-to-model-to-database vertical path are implemented and tested. It is suitable for controlled integrations and early production pilots.

Before a public, multi-tenant launch, integrate your own identity and authorization, use distributed rate limiting and webhook idempotency, define data lifecycle policy, cap provider spend, and run real-key load, browser, failure-injection, real-number SIP/SMS, and compliance tests in your target environment. Twilio transport and the SIP Runtime are implemented, but phone-number provisioning and jurisdiction-specific consent/compliance remain deployment responsibilities.

## Project

llmovoice is built by [AgenticSys Group](https://agenticsys.com), in research collaboration with the [SJTU Intelligent Networked Systems Lab](https://sites.gc.sjtu.edu.cn/yifei-zhu/), and in partnership with [CoachGPT](https://coachgpt.com).

The project is licensed under [Apache-2.0](./LICENSE). Contributions are welcome.
