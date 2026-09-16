# Getting started with llmovoice.js

This guide takes you from a memory-only context runtime to a realtime browser call with durable storage. You can stop at the layer your application needs: OpenAI, React, Next.js, PostgreSQL, and Supabase are integrations, not core requirements.

## What llmovoice does

llmovoice sits between conversation input and model generation:

1. It records a completed interaction as a **VoicePage**.
2. It appends that Page to an existing **VoiceThread** or creates a new one.
3. It retrieves Pages, Threads, and application-owned context relevant to the current turn.
4. It chooses transcript, summary, audio reference, or omission for every item under a hard budget.
5. It returns rendered context, an explanation trace, and bounded control directives.
6. A model or transport adapter uses that result to generate the actual response.

It does not replace your model, database, authentication system, tools, or product logic.

## Pick a starting path

| Goal | Start here | Requires |
| --- | --- | --- |
| Understand Pages, Threads, and compiled context | [Memory-only runtime](#2-create-a-memory-only-runtime) | Node.js |
| Try the complete repository UI | [Run the live lab](#1-run-the-live-lab) | Node.js, optional OpenAI key |
| Add microphone conversations | [Realtime browser call](#3-add-a-realtime-browser-call) | OpenAI API key, server route |
| Subscribe from React | [React state](#4-subscribe-from-react) | React 18+ |
| Persist on a trusted server | [PostgreSQL](#5-persist-with-postgresql) | PostgreSQL, optional pgvector |
| Use browser auth and row-level security | [Supabase](#6-persist-with-supabase-auth-and-rls) | Supabase project |
| Add profile, goals, or domain memory | [Application context](#7-add-application-owned-context) | `ContextSource` |
| Connect a real phone number or SMS | [Twilio Voice and SMS](./telephony.md) | Twilio, OpenAI Realtime SIP |

## 1. Run the live lab

Use Node.js 22+ and pnpm for the repository demo.

```bash
git clone https://github.com/llmovoice/llmovoice-js.git
cd llmovoice-js
pnpm install
cp apps/demo/.env.example apps/demo/.env.local
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Without credentials, text turns run locally against the in-memory runtime so you can inspect routing, projection, state, and traces.

To enable a real microphone conversation, add a standard OpenAI API key:

```env
# apps/demo/.env.local
OPENAI_API_KEY=sk-...
```

Restart `pnpm dev`, choose **Start live call**, and allow microphone access. The key is read only by the Next.js server route. The browser receives a short-lived Realtime client secret.

For a public deployment, also configure your identity provider or a high-entropy demo access token. Local development is intentionally allowed without this gate; production fails closed.

```env
LLMOVOICE_DEMO_ACCESS_TOKEN=replace-with-a-long-random-value
```

The website at [llmovoice.com](https://llmovoice.com) has a lightweight interaction preview. The repository live lab is the actual SDK integration and OpenAI Realtime test surface.

## 2. Create a memory-only runtime

Install the orchestration runtime:

```bash
pnpm add @llmovoice/runtime
```

Create one runtime for your application process and one session for a conversation:

```ts
import { createLlmovoice } from "@llmovoice/runtime";

const runtime = createLlmovoice({
  compiler: {
    budget: {
      maxInputTokens: 8_000,
      reservedOutputTokens: 1_000,
    },
  },
});

const session = runtime.createSession({
  userId: "user_123",
  sessionId: "conversation_456",
});

const prepared = await session.prepareTextTurn(
  "Find a dog-friendly hotel in Vancouver under $200.",
);

console.log(prepared.page);
console.log(prepared.routing);
console.log(prepared.context.rendered);
console.log(prepared.context.trace);
console.log(prepared.orchestration.directives);
```

`createLlmovoice()` uses `MemoryContextStore` by default. This is ideal for tests, local examples, and disposable processes. It is not durable across process restarts.

### Complete the assistant side of a Page

`prepareTextTurn()` creates the user side and prepares model context. After your model returns, ingest the final assistant transcript:

```ts
await session.ingest({
  type: "assistant.transcript.completed",
  text: "I found three options that fit your budget and allow dogs.",
  at: new Date().toISOString(),
});
```

This completes and saves the same Page. A voice transport normally emits this event for you.

### Observe runtime state

```ts
const unsubscribe = session.subscribe((snapshot) => {
  console.log(snapshot.pages);
  console.log(snapshot.threads);
  console.log(snapshot.compiledContext);
  console.log(snapshot.orchestration);
});

// Later
unsubscribe();
```

### Resume a durable session

Persist a stable session ID in your application, then create the session with `resume: true`:

```ts
const session = runtime.createSession({
  userId: authenticatedUser.id,
  sessionId: persistedSessionId,
  resume: true,
});
```

Resume matters only when the configured store is durable. It restores the sequence, recent state, usage, and active Thread history before the next turn.

## 3. Add a realtime browser call

Install the runtime and OpenAI integration:

```bash
pnpm add @llmovoice/runtime @llmovoice/openai
```

A browser must never receive your standard OpenAI API key. Mint a short-lived client secret from trusted server code, then let the browser establish WebRTC directly with OpenAI.

### Server: create a short-lived client secret

This example uses a Next.js route, but any trusted server framework works.

```ts
// app/api/realtime/token/route.ts
import { createHash } from "node:crypto";
import { createOpenAIRealtimeClientSecret } from "@llmovoice/openai";

export async function POST(request: Request) {
  // Authenticate and authorize request before minting a token.
  const user = await authenticateYourUser(request);
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const safetyIdentifier = createHash("sha256").update(user.id).digest("hex");

  const secret = await createOpenAIRealtimeClientSecret({
    apiKey: process.env.OPENAI_API_KEY!,
    model: "gpt-realtime",
    voice: "marin",
    instructions: "Respond naturally and concisely.",
    safetyIdentifier,
    expiresInSeconds: 120,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_024,
    signal: request.signal,
  });

  return Response.json({ value: secret.value });
}
```

Add authentication, same-origin or CSRF protection, distributed rate limiting, and spend caps before exposing this endpoint publicly. See the demo route for a bounded example.

### Browser: connect the runtime to WebRTC

```ts
import { OpenAIRealtimeClient } from "@llmovoice/openai";
import { createLlmovoice } from "@llmovoice/runtime";

const runtime = createLlmovoice();
const session = runtime.createSession({
  userId: authenticatedUser.id,
  sessionId: persistedSessionId,
  resume: true,
});

const realtime = new OpenAIRealtimeClient({
  tokenEndpoint: "/api/realtime/token",
  runtimeSession: session,
  tokenHeaders: async () => ({
    Authorization: `Bearer ${await getYourAccessToken()}`,
  }),
  baseInstructions: "Respect every relevant constraint in the compiled context.",
  reconnect: { maxAttempts: 3 },
});

await realtime.connect();
```

The browser asks for microphone permission, opens WebRTC, maps provider events into canonical llmovoice events, waits for compiled context before response creation, and samples transport telemetry.

Useful controls:

```ts
realtime.setMuted(true);
await realtime.sendText("Continue this topic in the same session.");
realtime.updateEnvironment({ latencyMs: 500, jitterMs: 180, packetLoss: 0.06 });
await realtime.disconnect();
realtime.dispose();
```

Subscribe to connection, speaking, error, runtime, and performance state:

```ts
const unsubscribe = realtime.subscribe((snapshot) => {
  console.log(snapshot.status);
  console.log(snapshot.userSpeaking, snapshot.assistantSpeaking);
  console.log(snapshot.runtime?.compiledContext);
  console.log(snapshot.performance.firstAudioLatencyMs);
});
```

## 4. Subscribe from React

```bash
pnpm add @llmovoice/react @llmovoice/runtime @llmovoice/openai
```

```tsx
"use client";

import { useLlmovoiceRuntime, useOpenAIRealtimeClient } from "@llmovoice/react";
import type { OpenAIRealtimeClient } from "@llmovoice/openai";
import type { LlmovoiceSession } from "@llmovoice/runtime";

export function VoiceStatus({
  session,
  client,
}: {
  session: LlmovoiceSession;
  client: OpenAIRealtimeClient | null;
}) {
  const runtime = useLlmovoiceRuntime(session);
  const realtime = useOpenAIRealtimeClient(client);

  return (
    <div>
      <p>Connection: {realtime?.status ?? "idle"}</p>
      <p>Pages: {runtime?.pages.length ?? 0}</p>
      <p>Threads: {runtime?.threads.length ?? 0}</p>
      <p>Projected tokens: {runtime?.compiledContext?.estimatedTokens ?? 0}</p>
    </div>
  );
}
```

Create the runtime, session, and Realtime client once with `useMemo`, a provider, or another stable lifecycle. Dispose the Realtime client during cleanup.

## 5. Persist with PostgreSQL

Use this adapter in a trusted server process:

```bash
pnpm add @llmovoice/runtime @llmovoice/postgres
```

```ts
import { PostgresContextStore } from "@llmovoice/postgres";
import { createLlmovoice } from "@llmovoice/runtime";

const store = new PostgresContextStore({
  connectionString: process.env.DATABASE_URL,
  vectorDimensions: 1536,
});

await store.migrate();

const runtime = createLlmovoice({ store });
```

The default schema is `llmovoice`. Set `vectorDimensions: false` when pgvector is unavailable; lexical and recency retrieval continue to work. The application remains responsible for authenticating `userId`, authorizing tenant access, securing database credentials, backups, encryption, and data lifecycle.

## 6. Persist with Supabase Auth and RLS

Supabase is useful when a browser application already uses Supabase Auth and wants durable context with row-level user isolation. It is optional.

```bash
pnpm add @llmovoice/runtime @llmovoice/supabase @supabase/supabase-js
```

### Apply and expose the schema

Apply the checked-in migration under [`supabase/migrations`](../supabase/migrations). It creates the canonical Pages, Threads, mappings, traces, vector functions, storage policy, and enrichment queue in the `llmovoice` schema.

Expose that schema in Supabase API settings. RLS remains the security boundary: the migration rejects anonymous data access and scopes authenticated rows to `auth.uid()`.

You may install the canonical objects under another safe schema name and pass that name to the store. Arbitrary legacy table names should be adapted with a custom `ContextStore`; do not let an untrusted browser choose schema or table identifiers.

### Create a user-scoped store

```ts
import { createClient } from "@supabase/supabase-js";
import { SupabaseContextStore } from "@llmovoice/supabase";
import { createLlmovoice } from "@llmovoice/runtime";

const supabase = createClient(supabaseUrl, publishableKey, {
  global: {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  },
});

const store = new SupabaseContextStore({
  client: supabase,
  userId: authenticatedUser.id,
  schema: "llmovoice",
  vectorDimensions: 1536,
});

const runtime = createLlmovoice({ store });
```

The store also implements the durable enrichment queue. When summary or embedding adapters are configured, incomplete work can be leased, retried, and recovered after a process restart.

Never derive `userId` from an unverified request body. A service-role client bypasses RLS, so trusted server code must still bind each store instance to an authenticated user.

## 7. Add application-owned context

Your application may already own profile, goal, preference, safety, CRM, or domain data. Keep it in the application database and expose only consented, relevant records through `ContextSource`.

### HTTP context source

```ts
import { HttpContextSource, createLlmovoice } from "@llmovoice/runtime";

const profileSource = new HttpContextSource({
  name: "profile",
  endpoint: "/api/voice-context",
  headers: async () => ({
    Authorization: `Bearer ${await getYourAccessToken()}`,
  }),
});

const runtime = createLlmovoice({
  sources: [profileSource],
});
```

By default the endpoint receives `q` and `limit` query parameters and returns either an array or `{ units: [...] }`:

```ts
{
  units: [
    {
      id: "preference_language",
      source: "profile",
      title: "Preferred language",
      content: "The user prefers Mandarin Chinese.",
      sensitivity: "personal",
      metadata: { consent: true },
      updatedAt: "2026-07-21T12:00:00.000Z"
    }
  ]
}
```

### Supabase table context source

```ts
import { SupabaseTableContextSource } from "@llmovoice/supabase";

type GoalRow = {
  id: string;
  title: string;
  summary: string;
  status: string;
  updated_at: string;
};

const goals = new SupabaseTableContextSource<GoalRow>({
  client: supabase,
  name: "goals",
  schema: "my_application",
  table: "goals",
  filters: { status: "active" },
  mapRow: (row) => ({
    id: `goal:${row.id}`,
    source: "goals",
    title: row.title,
    content: row.summary,
    updatedAt: row.updated_at,
    metadata: { consent: true },
  }),
});

const runtime = createLlmovoice({ sources: [goals] });
```

The source query runs under the supplied Supabase client's RLS identity. Filter sensitive rows before mapping them and preserve sensitivity or consent metadata for auditability.

## 8. Add optional OpenAI enrichment workers

The deterministic runtime works without model-backed workers. Trusted server processes can improve semantic routing, summaries, state extraction, and orchestration proposals:

```ts
import {
  OpenAIEmbeddingAdapter,
  OpenAIOrchestrationReasoner,
  OpenAIStateExtractionAdapter,
  OpenAISummaryAdapter,
} from "@llmovoice/openai";
import { createLlmovoice } from "@llmovoice/runtime";

const openai = { apiKey: process.env.OPENAI_API_KEY! };

const runtime = createLlmovoice({
  embedding: new OpenAIEmbeddingAdapter(openai),
  summary: new OpenAISummaryAdapter(openai),
  stateExtractor: new OpenAIStateExtractionAdapter(openai),
  orchestrationReasoner: new OpenAIOrchestrationReasoner(openai),
  prepareTurnBudgetMs: 250,
  stateExtractionMode: "background",
});
```

Keep these adapters server-side. They accept cancellation signals and have bounded realtime waits. If an optional worker fails or misses the turn deadline, llmovoice continues with lexical and recency retrieval, heuristic state, and deterministic safety controls.

## 9. Production checklist

Before exposing a real application:

- Keep standard model and database credentials in trusted server code.
- Authenticate every browser, phone, and messaging identity; authorize every tenant-scoped operation.
- Persist a stable session ID and use `resume: true` with a durable store.
- Configure a hard context budget, provider input/output caps, rate limits, and spend alerts.
- Use distributed rate limiting in multi-instance deployments.
- Validate RLS with two different users and keep service-role keys out of browsers.
- Implement retention, export, deletion, encryption, backup, and consent policy.
- Audit every `tool.*` and `app.*` directive executor as privileged code.
- Verify webhook signatures before parsing SIP or messaging events.
- Test reconnect, timeouts, provider errors, network degradation, browser permissions, and load in the target environment.
- Configure Twilio/OpenAI webhooks, persistent SIP sideband workers, distributed idempotency, phone identity, abuse controls, and compliance using the [Twilio Voice and SMS guide](./telephony.md).

Run the repository gates before releasing:

```bash
make check
make test-e2e
make benchmark
```

With test credentials configured:

```bash
make test-e2e-real
make supabase-test
```

## Troubleshooting

### The browser asks for a token or returns 401

If Supabase variables are configured, sign in with a real Supabase Auth user. Otherwise enter the same value configured as `LLMOVOICE_DEMO_ACCESS_TOKEN`. Local development without either gate is allowed; production is not.

### The call connects but context is not restored

Confirm that you use a durable store, the same authenticated `userId`, the same persisted `sessionId`, and `resume: true`. `MemoryContextStore` cannot survive a server or page-created runtime reset.

### Supabase reports that a table or function is missing

Apply the repository migration, expose the chosen schema in Supabase API settings, and pass that same schema to `SupabaseContextStore`. Keep the canonical table and RPC names together.

### pgvector reports an operator error

Use the checked-in migration, which schema-qualifies the vector operator. Confirm that the `vector` extension is installed and that embedding dimensions match the store configuration.

### Microphone access fails

Use HTTPS or localhost, allow browser microphone permission, close other exclusive audio applications, and test in a supported current browser. Text turns remain available without microphone access.

## Next reads

- [Architecture](./architecture.md)
- [OpenAI Realtime integration](./openai-realtime.md)
- [Twilio Voice, SIP, and SMS](./telephony.md)
- [Performance](./performance.md)
- [CoachGPT integration example](./coachgpt-integration.md)
- [Security policy](../SECURITY.md)
