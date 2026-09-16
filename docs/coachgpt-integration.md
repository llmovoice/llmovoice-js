# CoachGPT integration

CoachGPT and llmovoice should share identity and durable personal context, but not merge their storage models. CoachGPT remains the owner of profiles, goals, preferences, safety boundaries, and coaching history; llmovoice owns transient voice Pages, Threads, projection, and realtime control.

```text
CoachGPT personal_context_items ── ContextSource ─┐
                                                  ├─ ContextCompiler ─ Realtime response
llmovoice Pages / Threads ────────────────────────┘
```

When both applications share a Supabase project, use the generic table source. It respects the caller's JWT and propagates cancellation from the compiler deadline:

```ts
import { SupabaseTableContextSource } from "@llmovoice/supabase";

const coachgpt = new SupabaseTableContextSource({
  client: authenticatedSupabaseClient,
  name: "coachgpt",
  schema: "coachgpt",
  table: "personal_context_items",
  filters: {
    status: "active",
    kind: ["profile", "goal", "preference", "safety_boundary"],
  },
  mapRow: (row) => ({
    id: `coachgpt:${row.id}`,
    source: "coachgpt",
    title: row.title,
    content: row.summary,
    sensitivity: row.sensitivity,
    updatedAt: row.updated_at,
  }),
});
```

When CoachGPT is a separate service, expose a user-authenticated projection endpoint and use `HttpContextSource` from `@llmovoice/runtime`. The HTTP adapter deliberately does not put `userId` in its query string; the endpoint must derive identity from its cookie or bearer token.

Instantiate `SupabaseContextStore` with the same verified Supabase Auth user ID and pass the source to `createLlmovoice({ store, sources: [...] })`. Do not pass a browser-supplied `userId` without validating its access token first.

Recommended first integration:

1. Add the six published llmovoice packages through normal package dependencies; do not import monorepo source paths.
2. Adapt only active, user-confirmed CoachGPT context at first. Exclude rejected and archived items.
3. Treat `safety_boundary` items as application policy as well as context; prompt projection alone is not an authorization or safety boundary.
4. Keep sensitive context server-side and apply CoachGPT's consent/redaction rules before returning it from the source.
5. Use one Supabase user UUID across CoachGPT and `SupabaseContextStore` so RLS and application checks agree.
6. Add a cross-repository contract test covering identity, retrieval, Thread resume, logout, and deletion.

The source callback may query CoachGPT through its internal service API or a security-invoker Supabase RPC. A direct service-role query is acceptable only in trusted backend code and must remain explicitly scoped to the verified user.
