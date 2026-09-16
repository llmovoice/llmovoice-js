import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeTraceEvent, VoicePage, VoiceThread } from "@llmovoice/core";
import { SupabaseContextStore, SupabaseTableContextSource } from "./index";

const at = "2026-07-21T00:00:00.000Z";

function page(): VoicePage {
  return {
    id: "page_1",
    userId: "user-a",
    sessionId: "session-a",
    sequence: 1,
    status: "complete",
    input: { modality: "text", transcript: "dog friendly hotel", completedAt: at },
    output: { modality: "text", transcript: "Acknowledged", completedAt: at },
    summary: "dog friendly hotel",
    embedding: [1, 0, 0],
    state: {
      content: { explicitInstructions: [], entities: [], topics: ["hotel"] },
      style: {},
      environment: { latencyMs: 20, jitterMs: 2, packetLoss: 0, connection: "stable", observedAt: at },
      version: 1,
      observedAt: at,
    },
    availableFidelities: ["transcript", "summary", "drop"],
    threadIds: ["thread_1"],
    metadata: {},
    createdAt: at,
    updatedAt: at,
  };
}

function thread(): VoiceThread {
  return {
    id: "thread_1",
    userId: "user-a",
    title: "Hotel",
    summary: "dog friendly hotel",
    embedding: [1, 0, 0],
    pageIds: ["page_1"],
    status: "active",
    metadata: {},
    createdAt: at,
    updatedAt: at,
    lastActiveAt: at,
  };
}

function client(fetcher: typeof fetch) {
  return createClient("https://project.supabase.co", "anon-key", {
    global: { fetch: fetcher },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe("SupabaseContextStore", () => {
  it("binds every query and mutation to one authenticated user", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/rpc/match_pages")) return Response.json([{ payload: page() }]);
      if (url.includes("/pages") && (init?.method ?? "GET") === "GET") return Response.json([{ payload: page() }]);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const store = new SupabaseContextStore({ client: client(fetcher), userId: "user-a", vectorDimensions: 3 });

    await store.savePage(page());
    await expect(store.listPages("user-a")).resolves.toHaveLength(1);
    await expect(store.searchPages("user-a", [1, 0, 0], 999)).resolves.toHaveLength(1);
    await expect(store.listPages("user-b")).rejects.toThrow("cross-user");

    expect(requests.some(({ url }) => url.includes("user_id=eq.user-a"))).toBe(true);
    const rpcBody = requests.find(({ url }) => url.includes("/rpc/match_pages"))?.init?.body;
    expect(JSON.parse(String(rpcBody))).toMatchObject({ query_user_id: "user-a", match_count: 200 });
    expect(requests.every(({ init }) => new Headers(init?.headers).get("accept-profile") === "llmovoice"
      || new Headers(init?.headers).get("content-profile") === "llmovoice")).toBe(true);
  });

  it("persists normalized Thread mappings and user-scoped traces", async () => {
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (String(input).includes("/traces") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ payload: { id: "trace_1", userId: "user-a", sessionId: "session-a", type: "page.created", at, data: {} } }]);
      }
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 201 });
    }) as unknown as typeof fetch;
    const store = new SupabaseContextStore({ client: client(fetcher), userId: "user-a", vectorDimensions: 3 });
    await store.saveThread(thread());
    const trace: RuntimeTraceEvent = { id: "trace_1", userId: "user-a", sessionId: "session-a", type: "page.created", at, data: {} };
    await store.appendTrace(trace);
    await expect(store.listTraces("session-a", "user-a")).resolves.toMatchObject([{ id: "trace_1" }]);
    expect(bodies).toContainEqual(expect.objectContaining({ input_id: "thread_1", input_user_id: "user-a", input_page_ids: ["page_1"] }));
    expect(bodies).toContainEqual(expect.objectContaining({ user_id: "user-a", session_id: "session-a" }));
  });

  it("validates embeddings before they reach the database", async () => {
    const store = new SupabaseContextStore({ client: client(vi.fn() as unknown as typeof fetch), userId: "user-a", vectorDimensions: 3 });
    await expect(store.searchPages("user-a", [1, 2], 5)).rejects.toThrow("expected 3");
    await expect(store.searchThreads("user-a", [1, Number.NaN, 2], 5)).rejects.toThrow("non-finite");
  });

  it("batches records and claims enrichment with one atomic RPC", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.includes("/rpc/claim_enrichment")) return Response.json([{
        id: "job-1", user_id: "user-a", page_id: "page_1", status: "processing", attempts: 1, max_attempts: 5,
        available_at: at, lease_expires_at: at, worker_id: "worker-1", last_error: null, created_at: at, updated_at: at,
      }]);
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const store = new SupabaseContextStore({ client: client(fetcher), userId: "user-a", vectorDimensions: 3 });
    await store.savePages([page(), { ...page(), id: "page_2", sequence: 2 }]);
    await store.appendTraces([
      { id: "trace_1", userId: "user-a", sessionId: "session-a", type: "page.created", at, data: {} },
      { id: "trace_2", userId: "user-a", sessionId: "session-a", type: "page.completed", at, data: {} },
    ]);
    await store.enqueueEnrichment({ id: "job-1", userId: "user-a", pageId: "page_1", maxAttempts: 5, availableAt: at, createdAt: at, updatedAt: at });
    const claimed = await store.claimEnrichment({ userId: "user-a", workerId: "worker-1", leaseMs: 30_000 });
    expect(claimed).toMatchObject({ id: "job-1", status: "processing", attempts: 1 });
    expect(requests.find(({ url }) => url.includes("/pages"))?.body).toHaveLength(2);
    expect(requests.find(({ url }) => url.includes("/traces"))?.body).toHaveLength(2);
    expect(requests.find(({ url }) => url.includes("/rpc/claim_enrichment"))?.body).toMatchObject({ input_lease_ms: 30_000 });
  });
});

describe("SupabaseTableContextSource", () => {
  it("uses the authenticated user boundary and maps application rows", async () => {
    const requests: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json([{
        id: "goal-1", user_id: "user-a", kind: "goal", title: "Ship", summary: "Ship the launch",
        sensitivity: "normal", updated_at: at,
      }]);
    }) as unknown as typeof fetch;
    const source = new SupabaseTableContextSource<Record<string, unknown>>({
      client: client(fetcher),
      name: "coachgpt",
      schema: "coachgpt",
      table: "personal_context_items",
      filters: { status: "active", kind: ["profile", "goal", "preference"] },
      mapRow: (row) => ({
        id: String(row.id), source: "coachgpt", title: String(row.title), content: String(row.summary),
        sensitivity: String(row.sensitivity), updatedAt: String(row.updated_at),
      }),
    });

    await expect(source.retrieve({ userId: "user-a", query: "launch", limit: 4 })).resolves.toMatchObject([
      { id: "goal-1", source: "coachgpt", content: "Ship the launch" },
    ]);
    expect(requests[0]).toContain("user_id=eq.user-a");
    expect(requests[0]).toContain("status=eq.active");
    expect(requests[0]).toContain("kind=in.%28profile%2Cgoal%2Cpreference%29");
  });
});

describe("Supabase migration", () => {
  it("enforces RLS, relational ownership, pgvector HNSW, and invoker RPCs", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20260721000000_llmovoice_context.sql", import.meta.url), "utf8");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("references llmovoice.threads (id, user_id) on delete cascade");
    expect(sql).toContain("using hnsw (embedding extensions.vector_cosine_ops)");
    expect(sql).toContain("pages.embedding OPERATOR(extensions.<=>) query_embedding");
    expect(sql).toContain("threads.embedding OPERATOR(extensions.<=>) query_embedding");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("create or replace function llmovoice.upsert_thread");
    expect(sql).toContain("create or replace function llmovoice.claim_enrichment");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("enrichment_jobs_claim_idx");
    expect(sql).toContain("revoke all on schema llmovoice from public, anon");
    expect(sql).toContain("'llmovoice-audio'");
    expect(sql).toContain("storage.foldername(name))[1] = (select auth.uid())::text");
  });
});
