# @llmovoice/supabase

Supabase Auth/RLS and pgvector persistence for llmovoice.js.

```bash
pnpm add @llmovoice/supabase @supabase/supabase-js
```

```ts
import { createClient } from "@supabase/supabase-js";
import { SupabaseContextStore, SupabaseTableContextSource } from "@llmovoice/supabase";

const client = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${userAccessToken}` } },
});

const store = new SupabaseContextStore({
  client,
  userId: authenticatedUser.id,
});
```

`SupabaseTableContextSource` adapts an RLS-protected application table into compiler context without coupling llmovoice to that application's schema. Use it for profile, goal, preference, CRM, or domain context; filter to consented rows and preserve sensitivity metadata in `mapRow`.

Apply the repository's `supabase/migrations` before using the store and expose the `llmovoice` schema through the Supabase API settings. The migration enables RLS and grants no access to `anon`. `SupabaseContextStore` accepts a `schema` option for installations that deploy the same canonical tables, RPCs, and policies under another namespace. For arbitrary legacy table layouts, implement `ContextStore` instead of making internal table names browser-configurable.

The adapter batches Page and trace writes, bounds list queries, and implements `EnrichmentQueue`. When it is supplied as the runtime store, completed Page summary/embedding work is automatically persisted as leased jobs and recovered after process restarts.

The migration also creates a private `llmovoice-audio` bucket. Authenticated users can access objects only below `<auth.uid()>/...`; applications should store only opt-in audio, issue short-lived signed URLs, and enforce their retention/deletion policy.

For trusted server workloads, a service-role client may be used, but the service role bypasses RLS. `SupabaseContextStore` therefore remains bound to one explicit `userId` and rejects cross-user operations. Never construct that value from an unverified request field.
