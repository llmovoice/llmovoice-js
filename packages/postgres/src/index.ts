import { Pool, type PoolConfig } from "pg";
import type { ContextStore, EnrichmentJob, EnrichmentQueue, RuntimeTraceEvent, StoreListOptions, VoicePage, VoiceThread } from "@llmovoice/core";

export interface PostgresContextStoreOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
  schema?: string;
  vectorDimensions?: number | false;
}

function validateIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Invalid PostgreSQL identifier: ${identifier}`);
  }
  return identifier;
}

type EnrichmentRow = {
  id: string; user_id: string; page_id: string; status: EnrichmentJob["status"];
  attempts: number; max_attempts: number; available_at: Date | string; lease_expires_at: Date | string | null;
  worker_id: string | null; last_error: string | null; created_at: Date | string; updated_at: Date | string;
};

export class PostgresContextStore implements ContextStore, EnrichmentQueue {
  readonly pool: Pool;
  readonly schema: string;
  private readonly ownsPool: boolean;
  private readonly vectorDimensions: number | false;

  constructor(options: PostgresContextStoreOptions = {}) {
    this.schema = validateIdentifier(options.schema ?? "llmovoice");
    this.vectorDimensions = options.vectorDimensions === false ? false : options.vectorDimensions ?? 1536;
    if (this.vectorDimensions !== false && (!Number.isInteger(this.vectorDimensions) || this.vectorDimensions < 1 || this.vectorDimensions > 16_000)) {
      throw new Error("vectorDimensions must be an integer between 1 and 16000, or false.");
    }
    this.pool = options.pool ?? new Pool({
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...options.poolConfig,
      ...(options.connectionString ? { connectionString: options.connectionString } : {}),
    });
    this.ownsPool = !options.pool;
  }

  async migrate(): Promise<void> {
    const schema = this.schema;
    if (this.vectorDimensions !== false) await this.pool.query("create extension if not exists vector");
    await this.pool.query(`create schema if not exists ${schema}`);
    await this.pool.query(`
      create table if not exists ${schema}.pages (
        id text primary key,
        user_id text not null,
        session_id text not null,
        sequence integer not null,
        status text not null,
        payload jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (session_id, sequence)
      );
      create index if not exists pages_user_sequence_idx
        on ${schema}.pages (user_id, sequence asc);
      create index if not exists pages_session_updated_idx
        on ${schema}.pages (user_id, session_id, updated_at desc);

      create table if not exists ${schema}.threads (
        id text primary key,
        user_id text not null,
        status text not null,
        payload jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        last_active_at timestamptz not null
      );
      create index if not exists threads_user_active_idx
        on ${schema}.threads (user_id, last_active_at desc);

      create table if not exists ${schema}.traces (
        id text primary key,
        user_id text,
        session_id text not null,
        page_id text,
        thread_id text,
        type text not null,
        payload jsonb not null,
        created_at timestamptz not null
      );
      alter table ${schema}.traces add column if not exists user_id text;
      create index if not exists traces_user_session_created_idx
        on ${schema}.traces (user_id, session_id, created_at asc);

      create table if not exists ${schema}.enrichment_jobs (
        id text primary key,
        user_id text not null,
        page_id text not null references ${schema}.pages(id) on delete cascade,
        status text not null check (status in ('pending', 'processing', 'completed', 'failed')),
        attempts integer not null default 0,
        max_attempts integer not null default 5,
        available_at timestamptz not null,
        lease_expires_at timestamptz,
        worker_id text,
        last_error text,
        created_at timestamptz not null,
        updated_at timestamptz not null
      );
      create index if not exists enrichment_jobs_claim_idx
        on ${schema}.enrichment_jobs (user_id, status, available_at, lease_expires_at);
    `);
    if (this.vectorDimensions !== false) {
      const dimensions = this.vectorDimensions;
      await this.pool.query(`
        alter table ${schema}.pages add column if not exists embedding vector(${dimensions});
        alter table ${schema}.threads add column if not exists embedding vector(${dimensions});
        create index if not exists pages_embedding_hnsw_idx
          on ${schema}.pages using hnsw (embedding vector_cosine_ops) where embedding is not null;
        create index if not exists threads_embedding_hnsw_idx
          on ${schema}.threads using hnsw (embedding vector_cosine_ops) where embedding is not null;
      `);
    }
  }

  async savePage(page: VoicePage): Promise<void> {
    await this.pool.query(
      `insert into ${this.schema}.pages
        (id, user_id, session_id, sequence, status, payload, created_at, updated_at${this.vectorDimensions === false ? "" : ", embedding"})
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8${this.vectorDimensions === false ? "" : ", $9::vector"})
       on conflict (id) do update set
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at${this.vectorDimensions === false ? "" : ", embedding = excluded.embedding"}`,
      [
        page.id, page.userId, page.sessionId, page.sequence, page.status, JSON.stringify(page), page.createdAt, page.updatedAt,
        ...(this.vectorDimensions === false ? [] : [this.vector(page.embedding)]),
      ],
    );
  }

  async savePages(pages: VoicePage[]): Promise<void> {
    if (pages.length === 0) return;
    const records = pages.map((page) => ({
      id: page.id,
      user_id: page.userId,
      session_id: page.sessionId,
      sequence: page.sequence,
      status: page.status,
      payload: page,
      created_at: page.createdAt,
      updated_at: page.updatedAt,
      ...(this.vectorDimensions === false ? {} : { embedding: this.vector(page.embedding) }),
    }));
    await this.pool.query(
      `insert into ${this.schema}.pages
        (id, user_id, session_id, sequence, status, payload, created_at, updated_at${this.vectorDimensions === false ? "" : ", embedding"})
       select id, user_id, session_id, sequence, status, payload, created_at, updated_at${this.vectorDimensions === false ? "" : ", embedding::vector"}
       from jsonb_to_recordset($1::jsonb) as batch(
         id text, user_id text, session_id text, sequence integer, status text, payload jsonb,
         created_at timestamptz, updated_at timestamptz${this.vectorDimensions === false ? "" : ", embedding text"}
       )
       on conflict (id) do update set
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at${this.vectorDimensions === false ? "" : ", embedding = excluded.embedding"}`,
      [JSON.stringify(records)],
    );
  }

  async getPage(id: string, userId?: string): Promise<VoicePage | null> {
    const result = await this.pool.query<{ payload: VoicePage }>(
      `select payload from ${this.schema}.pages where id = $1${userId ? " and user_id = $2" : ""}`,
      userId ? [id, userId] : [id],
    );
    return result.rows[0]?.payload ?? null;
  }

  async listPages(userId: string, options: StoreListOptions = {}): Promise<VoicePage[]> {
    const limit = this.limit(options.limit);
    const values: unknown[] = [userId];
    const sessionFilter = options.sessionId ? ` and session_id = $${values.push(options.sessionId)}` : "";
    const limitClause = limit ? ` limit $${values.push(limit)}` : "";
    const result = await this.pool.query<{ payload: VoicePage }>(
      `select payload from ${this.schema}.pages where user_id = $1${sessionFilter} order by ${options.sessionId ? "sequence" : "created_at"} ${options.order === "desc" ? "desc" : "asc"}${limitClause}`,
      values,
    );
    return result.rows.map((row) => row.payload);
  }

  async saveThread(thread: VoiceThread): Promise<void> {
    await this.pool.query(
      `insert into ${this.schema}.threads
        (id, user_id, status, payload, created_at, updated_at, last_active_at${this.vectorDimensions === false ? "" : ", embedding"})
       values ($1, $2, $3, $4::jsonb, $5, $6, $7${this.vectorDimensions === false ? "" : ", $8::vector"})
       on conflict (id) do update set
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         last_active_at = excluded.last_active_at${this.vectorDimensions === false ? "" : ", embedding = excluded.embedding"}`,
      [
        thread.id, thread.userId, thread.status, JSON.stringify(thread), thread.createdAt, thread.updatedAt, thread.lastActiveAt,
        ...(this.vectorDimensions === false ? [] : [this.vector(thread.embedding)]),
      ],
    );
  }

  async saveThreads(threads: VoiceThread[]): Promise<void> {
    if (threads.length === 0) return;
    const records = threads.map((thread) => ({
      id: thread.id,
      user_id: thread.userId,
      status: thread.status,
      payload: thread,
      created_at: thread.createdAt,
      updated_at: thread.updatedAt,
      last_active_at: thread.lastActiveAt,
      ...(this.vectorDimensions === false ? {} : { embedding: this.vector(thread.embedding) }),
    }));
    await this.pool.query(
      `insert into ${this.schema}.threads
        (id, user_id, status, payload, created_at, updated_at, last_active_at${this.vectorDimensions === false ? "" : ", embedding"})
       select id, user_id, status, payload, created_at, updated_at, last_active_at${this.vectorDimensions === false ? "" : ", embedding::vector"}
       from jsonb_to_recordset($1::jsonb) as batch(
         id text, user_id text, status text, payload jsonb, created_at timestamptz,
         updated_at timestamptz, last_active_at timestamptz${this.vectorDimensions === false ? "" : ", embedding text"}
       )
       on conflict (id) do update set
         status = excluded.status,
         payload = excluded.payload,
         updated_at = excluded.updated_at,
         last_active_at = excluded.last_active_at${this.vectorDimensions === false ? "" : ", embedding = excluded.embedding"}`,
      [JSON.stringify(records)],
    );
  }

  async getThread(id: string, userId?: string): Promise<VoiceThread | null> {
    const result = await this.pool.query<{ payload: VoiceThread }>(
      `select payload from ${this.schema}.threads where id = $1${userId ? " and user_id = $2" : ""}`,
      userId ? [id, userId] : [id],
    );
    return result.rows[0]?.payload ?? null;
  }

  async listThreads(userId: string, options: StoreListOptions = {}): Promise<VoiceThread[]> {
    const limit = this.limit(options.limit);
    const result = await this.pool.query<{ payload: VoiceThread }>(
      `select payload from ${this.schema}.threads where user_id = $1 order by last_active_at ${options.order === "asc" ? "asc" : "desc"}${limit ? " limit $2" : ""}`,
      limit ? [userId, limit] : [userId],
    );
    return result.rows.map((row) => row.payload);
  }

  async appendTrace(event: RuntimeTraceEvent): Promise<void> {
    await this.pool.query(
      `insert into ${this.schema}.traces
        (id, user_id, session_id, page_id, thread_id, type, payload, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       on conflict (id) do nothing`,
      [event.id, event.userId ?? null, event.sessionId, event.pageId ?? null, event.threadId ?? null, event.type, JSON.stringify(event), event.at],
    );
  }

  async appendTraces(events: RuntimeTraceEvent[]): Promise<void> {
    if (events.length === 0) return;
    const records = events.map((event) => ({
      id: event.id,
      user_id: event.userId ?? null,
      session_id: event.sessionId,
      page_id: event.pageId ?? null,
      thread_id: event.threadId ?? null,
      type: event.type,
      payload: event,
      created_at: event.at,
    }));
    await this.pool.query(
      `insert into ${this.schema}.traces
        (id, user_id, session_id, page_id, thread_id, type, payload, created_at)
       select id, user_id, session_id, page_id, thread_id, type, payload, created_at
       from jsonb_to_recordset($1::jsonb) as batch(
         id text, user_id text, session_id text, page_id text, thread_id text,
         type text, payload jsonb, created_at timestamptz
       ) on conflict (id) do nothing`,
      [JSON.stringify(records)],
    );
  }

  async listTraces(sessionId: string, userId?: string, options: StoreListOptions = {}): Promise<RuntimeTraceEvent[]> {
    const limit = this.limit(options.limit);
    const params: unknown[] = userId ? [sessionId, userId] : [sessionId];
    if (limit) params.push(limit);
    const result = await this.pool.query<{ payload: RuntimeTraceEvent }>(
      `select payload from ${this.schema}.traces where session_id = $1${userId ? " and user_id = $2" : ""} order by created_at ${options.order === "desc" ? "desc" : "asc"}${limit ? ` limit $${params.length}` : ""}`,
      params,
    );
    return result.rows.map((row) => row.payload);
  }

  async searchPages(userId: string, embedding: number[], limit: number): Promise<VoicePage[]> {
    if (this.vectorDimensions === false) return [];
    const result = await this.pool.query<{ payload: VoicePage }>(
      `select payload from ${this.schema}.pages
       where user_id = $1 and embedding is not null
       order by embedding <=> $2::vector
       limit $3`,
      [userId, this.vector(embedding), Math.max(1, Math.min(200, limit))],
    );
    return result.rows.map((row) => row.payload);
  }

  async searchThreads(userId: string, embedding: number[], limit: number): Promise<VoiceThread[]> {
    if (this.vectorDimensions === false) return [];
    const result = await this.pool.query<{ payload: VoiceThread }>(
      `select payload from ${this.schema}.threads
       where user_id = $1 and embedding is not null
       order by embedding <=> $2::vector
       limit $3`,
      [userId, this.vector(embedding), Math.max(1, Math.min(200, limit))],
    );
    return result.rows.map((row) => row.payload);
  }

  async enqueueEnrichment(job: Pick<EnrichmentJob, "id" | "userId" | "pageId" | "maxAttempts" | "availableAt" | "createdAt" | "updatedAt">): Promise<void> {
    await this.pool.query(
      `insert into ${this.schema}.enrichment_jobs
        (id, user_id, page_id, status, attempts, max_attempts, available_at, created_at, updated_at)
       values ($1, $2, $3, 'pending', 0, $4, $5, $6, $7)
       on conflict (id) do update set
         available_at = case when ${this.schema}.enrichment_jobs.status in ('completed', 'processing') then ${this.schema}.enrichment_jobs.available_at else excluded.available_at end,
         status = case when ${this.schema}.enrichment_jobs.status = 'failed' then 'pending' else ${this.schema}.enrichment_jobs.status end,
         updated_at = excluded.updated_at`,
      [job.id, job.userId, job.pageId, job.maxAttempts, job.availableAt, job.createdAt, job.updatedAt],
    );
  }

  async claimEnrichment(input: { userId: string; workerId: string; leaseMs: number }): Promise<EnrichmentJob | null> {
    const result = await this.pool.query<EnrichmentRow>(
      `with candidate as (
         select id from ${this.schema}.enrichment_jobs
         where user_id = $1
           and attempts < max_attempts
           and available_at <= now()
           and (status = 'pending' or (status = 'processing' and lease_expires_at < now()))
         order by available_at asc, created_at asc
         for update skip locked
         limit 1
       )
       update ${this.schema}.enrichment_jobs as jobs
       set status = 'processing', attempts = attempts + 1, worker_id = $2,
           lease_expires_at = now() + ($3::integer * interval '1 millisecond'), updated_at = now()
       from candidate where jobs.id = candidate.id
       returning jobs.*`,
      [input.userId, input.workerId, Math.max(5_000, input.leaseMs)],
    );
    return result.rows[0] ? this.enrichmentJob(result.rows[0]) : null;
  }

  async completeEnrichment(input: { id: string; userId: string; workerId: string; completedAt: string }): Promise<void> {
    await this.pool.query(
      `update ${this.schema}.enrichment_jobs set status = 'completed', lease_expires_at = null,
         worker_id = null, last_error = null, updated_at = $4
       where id = $1 and user_id = $2 and worker_id = $3 and status = 'processing'`,
      [input.id, input.userId, input.workerId, input.completedAt],
    );
  }

  async failEnrichment(input: { id: string; userId: string; workerId: string; error: string; retryAt: string }): Promise<void> {
    await this.pool.query(
      `update ${this.schema}.enrichment_jobs
       set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
           available_at = $4, lease_expires_at = null, worker_id = null,
           last_error = left($5, 2000), updated_at = now()
       where id = $1 and user_id = $2 and worker_id = $3 and status = 'processing'`,
      [input.id, input.userId, input.workerId, input.retryAt, input.error],
    );
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private vector(embedding?: number[]): string | null {
    if (!embedding) return null;
    if (this.vectorDimensions !== false && embedding.length !== this.vectorDimensions) {
      throw new Error(`Embedding has ${embedding.length} dimensions; expected ${this.vectorDimensions}.`);
    }
    if (embedding.some((value) => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value.");
    return `[${embedding.join(",")}]`;
  }

  private limit(value?: number): number | undefined {
    if (value === undefined) return undefined;
    return Math.max(1, Math.min(10_000, Math.floor(value)));
  }

  private enrichmentJob(row: EnrichmentRow): EnrichmentJob {
    const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return {
      id: row.id,
      userId: row.user_id,
      pageId: row.page_id,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: iso(row.available_at),
      ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
