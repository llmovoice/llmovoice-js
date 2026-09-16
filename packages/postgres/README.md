# @llmovoice/postgres

PostgreSQL persistence and pgvector retrieval for llmovoice.js VoicePages, VoiceThreads, and runtime traces.

```bash
pnpm add @llmovoice/postgres @llmovoice/runtime
```

```ts
import { PostgresContextStore } from "@llmovoice/postgres";

const store = new PostgresContextStore({
  connectionString: process.env.DATABASE_URL,
  vectorDimensions: 1536,
});
await store.migrate();
```

Migration installs the `vector` extension and creates HNSW cosine indexes. The configured dimensions must match the embedding adapter. Use `vectorDimensions: false` when the database cannot provide pgvector; routing and compilation retain bounded lexical/recency fallback behavior.

The store includes bounded list queries, JSONB batch upserts, pooled connection defaults, and an atomic leased enrichment queue. Passing it directly to `createLlmovoice({ store })` enables durable summary/embedding recovery.

Queries include `user_id`, but applications remain responsible for authenticating and authorizing that identity, tenant isolation, encryption, backups, deletion, and retention.
