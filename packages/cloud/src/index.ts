import type { ContextStore, RuntimeTraceEvent, StoreListOptions, VoicePage, VoiceThread } from "@llmovoice/core";

export interface CloudContextStoreOptions {
  apiKey: string;
  userId: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxListItems?: number;
  fetch?: typeof fetch;
}

export class LlmovoiceCloudError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}

interface ListResult<T> { items: T[]; nextCursor?: string }
interface PageRecord { id: string; endUserId: string; sessionId: string; sequence: number; status: VoicePage["status"]; payload: VoicePage; embedding?: number[] | null; createdAt: string; updatedAt: string }
interface ThreadRecord { id: string; endUserId: string; status: VoiceThread["status"]; payload: VoiceThread; pageIds: string[]; embedding?: number[] | null; createdAt: string; updatedAt: string; lastActiveAt: string }
interface TraceRecord { id: string; endUserId: string; sessionId: string; pageId?: string | null; threadId?: string | null; type: string; payload: RuntimeTraceEvent; createdAt: string }

export class CloudContextStore implements ContextStore {
  readonly userId: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxListItems: number;
  readonly #fetch: typeof fetch;

  constructor(options: CloudContextStoreOptions) {
    this.userId = options.userId.trim();
    if (!this.userId) throw new Error("CloudContextStore requires an authenticated userId.");
    if (!options.apiKey.startsWith("lmv_")) throw new Error("CloudContextStore requires a server-side llmovoice project API key.");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.llmovoice.com").replace(/\/$/, "");
    this.#timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
    this.#maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2));
    this.#maxListItems = Math.max(1, Math.min(10_000, options.maxListItems ?? 2_000));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async savePage(page: VoicePage): Promise<void> { await this.savePages([page]); }
  async savePages(pages: VoicePage[]): Promise<void> {
    if (!pages.length) return;
    for (const page of pages) this.assertUser(page.userId);
    for (let index = 0; index < pages.length; index += 100) {
      const items: PageRecord[] = pages.slice(index, index + 100).map((page) => ({
        id: page.id, endUserId: page.userId, sessionId: page.sessionId, sequence: page.sequence,
        status: page.status, payload: page, ...(page.embedding ? { embedding: page.embedding } : {}),
        createdAt: page.createdAt, updatedAt: page.updatedAt,
      }));
      await this.request("/v1/context/pages:batch", { method: "POST", body: { items } });
    }
  }

  async getPage(id: string, userId = this.userId): Promise<VoicePage | null> {
    this.assertUser(userId);
    try { return (await this.request<PageRecord>(`/v1/context/pages/${encodeURIComponent(id)}?endUserId=${encodeURIComponent(this.userId)}`)).payload; }
    catch (error) { if (error instanceof LlmovoiceCloudError && error.status === 404) return null; throw error; }
  }

  async listPages(userId: string, options: StoreListOptions = {}): Promise<VoicePage[]> {
    this.assertUser(userId);
    const items = await this.listAll<PageRecord>("/v1/context/pages", { endUserId: this.userId, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }, options.limit);
    const pages = items.map((item) => item.payload).sort((left, right) => options.sessionId ? left.sequence - right.sequence : left.createdAt.localeCompare(right.createdAt));
    if (options.order === "desc") pages.reverse();
    return pages.slice(0, options.limit ?? pages.length);
  }

  async searchPages(userId: string, embedding: number[], limit: number): Promise<VoicePage[]> {
    this.assertUser(userId);
    this.assertEmbedding(embedding);
    const result = await this.request<{ items: PageRecord[] }>("/v1/context/pages:search", { method: "POST", body: { endUserId: this.userId, embedding, limit: this.limit(limit, 200) } });
    return result.items.map((item) => item.payload);
  }

  async saveThread(thread: VoiceThread): Promise<void> { await this.saveThreads([thread]); }
  async saveThreads(threads: VoiceThread[]): Promise<void> {
    if (!threads.length) return;
    for (const thread of threads) this.assertUser(thread.userId);
    for (let index = 0; index < threads.length; index += 100) {
      const items: ThreadRecord[] = threads.slice(index, index + 100).map((thread) => ({
        id: thread.id, endUserId: thread.userId, status: thread.status, payload: thread,
        pageIds: thread.pageIds, ...(thread.embedding ? { embedding: thread.embedding } : {}),
        createdAt: thread.createdAt, updatedAt: thread.updatedAt, lastActiveAt: thread.lastActiveAt,
      }));
      await this.request("/v1/context/threads:batch", { method: "POST", body: { items } });
    }
  }

  async getThread(id: string, userId = this.userId): Promise<VoiceThread | null> {
    this.assertUser(userId);
    try { return (await this.request<ThreadRecord>(`/v1/context/threads/${encodeURIComponent(id)}?endUserId=${encodeURIComponent(this.userId)}`)).payload; }
    catch (error) { if (error instanceof LlmovoiceCloudError && error.status === 404) return null; throw error; }
  }

  async listThreads(userId: string, options: StoreListOptions = {}): Promise<VoiceThread[]> {
    this.assertUser(userId);
    const items = await this.listAll<ThreadRecord>("/v1/context/threads", { endUserId: this.userId }, options.limit);
    const threads = items.map((item) => item.payload).sort((left, right) => left.lastActiveAt.localeCompare(right.lastActiveAt));
    if (options.order !== "asc") threads.reverse();
    return threads.slice(0, options.limit ?? threads.length);
  }

  async searchThreads(userId: string, embedding: number[], limit: number): Promise<VoiceThread[]> {
    this.assertUser(userId);
    this.assertEmbedding(embedding);
    const result = await this.request<{ items: ThreadRecord[] }>("/v1/context/threads:search", { method: "POST", body: { endUserId: this.userId, embedding, limit: this.limit(limit, 200) } });
    return result.items.map((item) => item.payload);
  }

  async appendTrace(event: RuntimeTraceEvent): Promise<void> { await this.appendTraces([event]); }
  async appendTraces(events: RuntimeTraceEvent[]): Promise<void> {
    if (!events.length) return;
    for (const event of events) if (event.userId) this.assertUser(event.userId);
    for (let index = 0; index < events.length; index += 500) {
      const items: TraceRecord[] = events.slice(index, index + 500).map((event) => ({
        id: event.id, endUserId: this.userId, sessionId: event.sessionId,
        ...(event.pageId ? { pageId: event.pageId } : {}), ...(event.threadId ? { threadId: event.threadId } : {}),
        type: event.type, payload: { ...event, userId: this.userId }, createdAt: event.at,
      }));
      await this.request("/v1/traces:batch", { method: "POST", body: { items } });
    }
  }

  async listTraces(sessionId: string, userId = this.userId, options: StoreListOptions = {}): Promise<RuntimeTraceEvent[]> {
    this.assertUser(userId);
    const items = await this.listAll<TraceRecord>("/v1/traces", { endUserId: this.userId, sessionId }, options.limit);
    const traces = items.map((item) => item.payload).sort((left, right) => left.at.localeCompare(right.at));
    if (options.order === "desc") traces.reverse();
    return traces.slice(0, options.limit ?? traces.length);
  }

  async requestExport(): Promise<{ id: string }> { return this.request("/v1/data/exports", { method: "POST", body: { endUserId: this.userId } }); }
  async requestDeletion(reason = "user_request"): Promise<{ id: string }> { return this.request("/v1/data/deletions", { method: "POST", body: { endUserId: this.userId, reason } }); }
  async getJob(id: string): Promise<{ id: string; status: string; result?: Record<string, unknown> }> { return this.request(`/v1/jobs/${encodeURIComponent(id)}`); }

  private assertUser(userId: string): void { if (userId !== this.userId) throw new Error("CloudContextStore rejected a cross-user operation."); }
  private assertEmbedding(value: number[]): void { if (value.length !== 1536 || value.some((item) => !Number.isFinite(item))) throw new Error("Cloud vector search requires a finite 1536-dimensional embedding."); }
  private limit(value: number, max: number): number { return Math.max(1, Math.min(max, Math.floor(value))); }

  private async listAll<T>(path: string, query: Record<string, string>, requested?: number): Promise<T[]> {
    const maximum = Math.min(this.#maxListItems, requested ?? this.#maxListItems);
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const limit = Math.min(200, maximum - items.length);
      if (limit <= 0) break;
      const result = await this.request<ListResult<T>>(`${path}?${new URLSearchParams({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) })}`);
      items.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor && items.length < maximum);
    return items;
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.#timeoutMs)]) : AbortSignal.timeout(this.#timeoutMs);
      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: options.method ?? "GET", headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", "user-agent": "@llmovoice/cloud/0.1.0" },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal,
        });
        const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; requestId?: string } };
        if (response.ok) return payload as T;
        if ((response.status === 429 || response.status >= 500) && attempt < this.#maxRetries) { await delay(Math.min(1_000, 100 * 2 ** attempt)); continue; }
        throw new LlmovoiceCloudError(response.status, payload.error?.code ?? "request_failed", payload.error?.message ?? `Cloud request failed with ${response.status}`, payload.error?.requestId);
      } catch (error) {
        if (error instanceof LlmovoiceCloudError || attempt >= this.#maxRetries || options.signal?.aborted) throw error;
        await delay(Math.min(1_000, 100 * 2 ** attempt));
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
