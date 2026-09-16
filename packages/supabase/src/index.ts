import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContextSource, ContextStore, EnrichmentJob, EnrichmentQueue, ExternalContextUnit, RuntimeTraceEvent, StoreListOptions, VoicePage, VoiceThread } from "@llmovoice/core";

export interface SupabaseContextStoreOptions {
  client: SupabaseClient<any>;
  userId: string;
  schema?: string;
  vectorDimensions?: number | false;
}

type PayloadRow<T> = { payload: T };

export interface SupabaseTableContextSourceOptions<Row extends Record<string, unknown>> {
  client: SupabaseClient<any>;
  name: string;
  schema: string;
  table: string;
  select?: string;
  userColumn?: string;
  filters?: Record<string, string | number | boolean | Array<string | number | boolean>>;
  orderBy?: string | false;
  mapRow: (row: Row) => ExternalContextUnit | null;
  fetchMultiplier?: number;
}

export class SupabaseTableContextSource<Row extends Record<string, unknown>> implements ContextSource {
  readonly name: string;

  constructor(private readonly options: SupabaseTableContextSourceOptions<Row>) {
    this.name = options.name.trim();
    if (!this.name) throw new Error("SupabaseTableContextSource requires a name.");
    safeSchema(options.schema);
    safeSchema(options.table);
    safeSchema(options.userColumn ?? "user_id");
    if (options.orderBy !== false) safeSchema(options.orderBy ?? "updated_at");
  }

  async retrieve(input: { userId: string; query: string; limit: number; signal?: AbortSignal }): Promise<ExternalContextUnit[]> {
    const cappedLimit = Math.max(1, Math.min(100, Math.ceil(input.limit * (this.options.fetchMultiplier ?? 3))));
    let query = this.options.client.schema(this.options.schema).from(this.options.table)
      .select(this.options.select ?? "*")
      .eq(this.options.userColumn ?? "user_id", input.userId);
    for (const [column, value] of Object.entries(this.options.filters ?? {})) {
      safeSchema(column);
      query = Array.isArray(value) ? query.in(column, value) : query.eq(column, value);
    }
    if (this.options.orderBy !== false) query = query.order(this.options.orderBy ?? "updated_at", { ascending: false });
    query = query.limit(cappedLimit);
    if (input.signal) query = query.abortSignal(input.signal);
    const { data, error } = await query;
    if (error) throw new Error(`Could not retrieve ${this.name} context: ${error.message}`);
    const units = ((data ?? []) as unknown as Row[])
      .map(this.options.mapRow)
      .filter((unit): unit is ExternalContextUnit => Boolean(unit));
    return units.slice(0, Math.max(0, input.limit));
  }
}

function safeSchema(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid Supabase schema: ${value}`);
  return value;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "Unknown Supabase error.";
}

type EnrichmentRow = {
  id: string; user_id: string; page_id: string; status: EnrichmentJob["status"];
  attempts: number; max_attempts: number; available_at: string; lease_expires_at: string | null;
  worker_id: string | null; last_error: string | null; created_at: string; updated_at: string;
};

export class SupabaseContextStore implements ContextStore, EnrichmentQueue {
  readonly userId: string;
  readonly schema: string;
  private readonly vectorDimensions: number | false;

  constructor(private readonly options: SupabaseContextStoreOptions) {
    this.userId = options.userId.trim();
    if (!this.userId) throw new Error("SupabaseContextStore requires an authenticated userId.");
    this.schema = safeSchema(options.schema ?? "llmovoice");
    this.vectorDimensions = options.vectorDimensions === false ? false : options.vectorDimensions ?? 1536;
    if (this.vectorDimensions !== false && (!Number.isInteger(this.vectorDimensions) || this.vectorDimensions < 1 || this.vectorDimensions > 2_000)) {
      throw new Error("vectorDimensions must be an integer between 1 and 2000, or false.");
    }
  }

  async savePage(page: VoicePage): Promise<void> {
    this.assertUser(page.userId);
    const { error } = await this.db().from("pages").upsert({
      id: page.id,
      user_id: page.userId,
      session_id: page.sessionId,
      sequence: page.sequence,
      status: page.status,
      payload: page,
      embedding: this.vector(page.embedding),
      created_at: page.createdAt,
      updated_at: page.updatedAt,
    }, { onConflict: "id" });
    this.throwIfError(error, "save Page");
  }

  async savePages(pages: VoicePage[]): Promise<void> {
    if (pages.length === 0) return;
    for (const page of pages) this.assertUser(page.userId);
    const { error } = await this.db().from("pages").upsert(pages.map((page) => ({
      id: page.id,
      user_id: page.userId,
      session_id: page.sessionId,
      sequence: page.sequence,
      status: page.status,
      payload: page,
      embedding: this.vector(page.embedding),
      created_at: page.createdAt,
      updated_at: page.updatedAt,
    })), { onConflict: "id" });
    this.throwIfError(error, "save Pages");
  }

  async getPage(id: string, userId = this.userId): Promise<VoicePage | null> {
    this.assertUser(userId);
    const { data, error } = await this.db().from("pages")
      .select("payload")
      .eq("id", id)
      .eq("user_id", this.userId)
      .maybeSingle();
    this.throwIfError(error, "get Page");
    return (data as PayloadRow<VoicePage> | null)?.payload ?? null;
  }

  async listPages(userId: string, options: StoreListOptions = {}): Promise<VoicePage[]> {
    this.assertUser(userId);
    let query = this.db().from("pages")
      .select("payload")
      .eq("user_id", this.userId)
      .order(options.sessionId ? "sequence" : "created_at", { ascending: options.order !== "desc" });
    if (options.sessionId) query = query.eq("session_id", options.sessionId);
    if (options.limit !== undefined) query = query.limit(this.listLimit(options.limit));
    const { data, error } = await query;
    this.throwIfError(error, "list Pages");
    return ((data ?? []) as Array<PayloadRow<VoicePage>>).map((row) => row.payload);
  }

  async saveThread(thread: VoiceThread): Promise<void> {
    this.assertUser(thread.userId);
    const { error } = await this.db().rpc("upsert_thread", {
      input_id: thread.id,
      input_user_id: thread.userId,
      input_status: thread.status,
      input_payload: thread,
      input_embedding: this.vector(thread.embedding),
      input_page_ids: thread.pageIds,
      input_created_at: thread.createdAt,
      input_updated_at: thread.updatedAt,
      input_last_active_at: thread.lastActiveAt,
    });
    this.throwIfError(error, "save Thread");
  }

  async saveThreads(threads: VoiceThread[]): Promise<void> {
    await Promise.all(threads.map((thread) => this.saveThread(thread)));
  }

  async getThread(id: string, userId = this.userId): Promise<VoiceThread | null> {
    this.assertUser(userId);
    const { data, error } = await this.db().from("threads")
      .select("payload")
      .eq("id", id)
      .eq("user_id", this.userId)
      .maybeSingle();
    this.throwIfError(error, "get Thread");
    return (data as PayloadRow<VoiceThread> | null)?.payload ?? null;
  }

  async listThreads(userId: string, options: StoreListOptions = {}): Promise<VoiceThread[]> {
    this.assertUser(userId);
    let query = this.db().from("threads")
      .select("payload")
      .eq("user_id", this.userId)
      .order("last_active_at", { ascending: options.order === "asc" });
    if (options.limit !== undefined) query = query.limit(this.listLimit(options.limit));
    const { data, error } = await query;
    this.throwIfError(error, "list Threads");
    return ((data ?? []) as Array<PayloadRow<VoiceThread>>).map((row) => row.payload);
  }

  async appendTrace(event: RuntimeTraceEvent): Promise<void> {
    if (event.userId) this.assertUser(event.userId);
    const payload = { ...event, userId: this.userId };
    const { error } = await this.db().from("traces").upsert({
      id: event.id,
      user_id: this.userId,
      session_id: event.sessionId,
      page_id: event.pageId ?? null,
      thread_id: event.threadId ?? null,
      type: event.type,
      payload,
      created_at: event.at,
    }, { onConflict: "id", ignoreDuplicates: true });
    this.throwIfError(error, "append trace");
  }

  async appendTraces(events: RuntimeTraceEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) if (event.userId) this.assertUser(event.userId);
    const { error } = await this.db().from("traces").upsert(events.map((event) => ({
      id: event.id,
      user_id: this.userId,
      session_id: event.sessionId,
      page_id: event.pageId ?? null,
      thread_id: event.threadId ?? null,
      type: event.type,
      payload: { ...event, userId: this.userId },
      created_at: event.at,
    })), { onConflict: "id", ignoreDuplicates: true });
    this.throwIfError(error, "append traces");
  }

  async listTraces(sessionId: string, userId = this.userId, options: StoreListOptions = {}): Promise<RuntimeTraceEvent[]> {
    this.assertUser(userId);
    let query = this.db().from("traces")
      .select("payload")
      .eq("user_id", this.userId)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: options.order !== "desc" });
    if (options.limit !== undefined) query = query.limit(this.listLimit(options.limit));
    const { data, error } = await query;
    this.throwIfError(error, "list traces");
    return ((data ?? []) as Array<PayloadRow<RuntimeTraceEvent>>).map((row) => row.payload);
  }

  async searchPages(userId: string, embedding: number[], limit: number): Promise<VoicePage[]> {
    this.assertUser(userId);
    if (this.vectorDimensions === false) return [];
    const { data, error } = await this.db().rpc("match_pages", {
      query_user_id: this.userId,
      query_embedding: this.vector(embedding),
      match_count: this.searchLimit(limit),
    });
    this.throwIfError(error, "search Pages");
    return ((data ?? []) as Array<PayloadRow<VoicePage>>).map((row) => row.payload);
  }

  async searchThreads(userId: string, embedding: number[], limit: number): Promise<VoiceThread[]> {
    this.assertUser(userId);
    if (this.vectorDimensions === false) return [];
    const { data, error } = await this.db().rpc("match_threads", {
      query_user_id: this.userId,
      query_embedding: this.vector(embedding),
      match_count: this.searchLimit(limit),
    });
    this.throwIfError(error, "search Threads");
    return ((data ?? []) as Array<PayloadRow<VoiceThread>>).map((row) => row.payload);
  }

  async enqueueEnrichment(job: Pick<EnrichmentJob, "id" | "userId" | "pageId" | "maxAttempts" | "availableAt" | "createdAt" | "updatedAt">): Promise<void> {
    this.assertUser(job.userId);
    const { error } = await this.db().from("enrichment_jobs").upsert({
      id: job.id,
      user_id: job.userId,
      page_id: job.pageId,
      status: "pending",
      attempts: 0,
      max_attempts: job.maxAttempts,
      available_at: job.availableAt,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    }, { onConflict: "id", ignoreDuplicates: true });
    this.throwIfError(error, "enqueue enrichment");
  }

  async claimEnrichment(input: { userId: string; workerId: string; leaseMs: number }): Promise<EnrichmentJob | null> {
    this.assertUser(input.userId);
    const { data, error } = await this.db().rpc("claim_enrichment", {
      input_user_id: this.userId,
      input_worker_id: input.workerId,
      input_lease_ms: Math.max(5_000, Math.floor(input.leaseMs)),
    });
    this.throwIfError(error, "claim enrichment");
    const row = (Array.isArray(data) ? data[0] : data) as EnrichmentRow | null;
    return row ? this.enrichmentJob(row) : null;
  }

  async completeEnrichment(input: { id: string; userId: string; workerId: string; completedAt: string }): Promise<void> {
    this.assertUser(input.userId);
    const { error } = await this.db().from("enrichment_jobs").update({
      status: "completed", lease_expires_at: null, worker_id: null, last_error: null, updated_at: input.completedAt,
    }).eq("id", input.id).eq("user_id", this.userId).eq("worker_id", input.workerId).eq("status", "processing");
    this.throwIfError(error, "complete enrichment");
  }

  async failEnrichment(input: { id: string; userId: string; workerId: string; error: string; retryAt: string }): Promise<void> {
    this.assertUser(input.userId);
    const { error } = await this.db().rpc("fail_enrichment", {
      input_id: input.id,
      input_user_id: this.userId,
      input_worker_id: input.workerId,
      input_error: input.error.slice(0, 2_000),
      input_retry_at: input.retryAt,
    });
    this.throwIfError(error, "fail enrichment");
  }

  private db() {
    return this.options.client.schema(this.schema);
  }

  private assertUser(userId: string): void {
    if (userId !== this.userId) throw new Error("SupabaseContextStore rejected a cross-user operation.");
  }

  private throwIfError(error: unknown, operation: string): void {
    if (error) throw new Error(`Could not ${operation}: ${errorMessage(error)}`);
  }

  private searchLimit(value: number): number {
    return Math.max(1, Math.min(200, Math.floor(value)));
  }

  private listLimit(value: number): number {
    return Math.max(1, Math.min(10_000, Math.floor(value)));
  }

  private vector(embedding?: number[]): number[] | null {
    if (!embedding) return null;
    if (this.vectorDimensions !== false && embedding.length !== this.vectorDimensions) {
      throw new Error(`Embedding has ${embedding.length} dimensions; expected ${this.vectorDimensions}.`);
    }
    if (embedding.some((value) => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value.");
    return embedding;
  }

  private enrichmentJob(row: EnrichmentRow): EnrichmentJob {
    return {
      id: row.id,
      userId: row.user_id,
      pageId: row.page_id,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at,
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
      ...(row.worker_id ? { workerId: row.worker_id } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
