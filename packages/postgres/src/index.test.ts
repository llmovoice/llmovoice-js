import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { RuntimeTraceEvent, VoicePage, VoiceThread } from "@llmovoice/core";
import { PostgresContextStore } from "./index";

function fakePool() {
  const query = vi.fn(async (_statement: string, _params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> => ({ rows: [] }));
  return { pool: { query } as unknown as Pool, query };
}

function page(embedding?: number[]): VoicePage {
  const at = new Date().toISOString();
  return {
    id: "p1", userId: "u1", sessionId: "s1", sequence: 1, status: "complete",
    input: { modality: "text", transcript: "hello" }, summary: "hello",
    state: {
      content: { explicitInstructions: [], entities: [], topics: [] },
      style: {},
      environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: at },
      version: 1, observedAt: at,
    },
    availableFidelities: ["transcript", "summary", "drop"], threadIds: [], metadata: {},
    createdAt: at, updatedAt: at,
    ...(embedding ? { embedding } : {}),
  };
}

function thread(embedding?: number[]): VoiceThread {
  const at = new Date().toISOString();
  return {
    id: "t1", userId: "u1", title: "Greeting", summary: "hello", pageIds: ["p1"], status: "active",
    metadata: {}, createdAt: at, updatedAt: at, lastActiveAt: at,
    ...(embedding ? { embedding } : {}),
  };
}

describe("PostgresContextStore vector persistence", () => {
  it("installs pgvector and creates HNSW cosine indexes", async () => {
    const { pool, query } = fakePool();
    await new PostgresContextStore({ pool, vectorDimensions: 3 }).migrate();
    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("create extension if not exists vector");
    expect(sql).toContain("embedding vector(3)");
    expect(sql).toContain("using hnsw");
    expect(sql).toContain("vector_cosine_ops");
  });

  it("writes and searches vectors with tenant-scoped SQL", async () => {
    const { pool, query } = fakePool();
    const store = new PostgresContextStore({ pool, vectorDimensions: 3 });
    await store.savePage(page([1, 0, 0]));
    await store.searchPages("u1", [1, 0, 0], 20);
    expect(query.mock.calls[0]?.[1]).toContain("[1,0,0]");
    expect(String(query.mock.calls[1]?.[0])).toContain("where user_id = $1");
    expect(String(query.mock.calls[1]?.[0])).toContain("embedding <=> $2::vector");
  });

  it("rejects embeddings with the wrong dimension", async () => {
    const { pool } = fakePool();
    const store = new PostgresContextStore({ pool, vectorDimensions: 3 });
    await expect(store.savePage(page([1, 0]))).rejects.toThrow("expected 3");
  });

  it("round-trips tenant-scoped Pages, Threads, and traces", async () => {
    const { pool, query } = fakePool();
    const store = new PostgresContextStore({ pool, vectorDimensions: 3 });
    const savedPage = page([1, 0, 0]);
    const savedThread = thread([1, 0, 0]);
    const trace: RuntimeTraceEvent = {
      id: "trace1", userId: "u1", sessionId: "s1", type: "page.created", at: savedPage.createdAt, data: {},
    };
    query
      .mockResolvedValueOnce({ rows: [{ payload: savedPage }] })
      .mockResolvedValueOnce({ rows: [{ payload: savedPage }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload: savedThread }] })
      .mockResolvedValueOnce({ rows: [{ payload: savedThread }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ payload: trace }] })
      .mockResolvedValueOnce({ rows: [{ payload: savedThread }] });

    await expect(store.getPage("p1", "u1")).resolves.toEqual(savedPage);
    await expect(store.listPages("u1")).resolves.toEqual([savedPage]);
    await store.saveThread(savedThread);
    await expect(store.getThread("t1", "u1")).resolves.toEqual(savedThread);
    await expect(store.listThreads("u1")).resolves.toEqual([savedThread]);
    await store.appendTrace(trace);
    await expect(store.listTraces("s1", "u1")).resolves.toEqual([trace]);
    await expect(store.searchThreads("u1", [1, 0, 0], 999)).resolves.toEqual([savedThread]);

    expect(String(query.mock.calls[0]?.[0])).toContain("and user_id = $2");
    expect(String(query.mock.calls[6]?.[0])).toContain("and user_id = $2");
    expect(query.mock.calls[7]?.[1]?.[2]).toBe(200);
  });

  it("supports installations without pgvector", async () => {
    const { pool, query } = fakePool();
    const store = new PostgresContextStore({ pool, vectorDimensions: false });
    await store.migrate();
    await store.savePage(page());
    await expect(store.searchPages("u1", [1], 2)).resolves.toEqual([]);
    await expect(store.searchThreads("u1", [1], 2)).resolves.toEqual([]);
    expect(query.mock.calls.some(([statement]) => String(statement).includes("create extension"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[1]).toHaveLength(8);
    await store.close();
  });

  it("rejects unsafe schema names and non-finite vectors", async () => {
    const { pool } = fakePool();
    expect(() => new PostgresContextStore({ pool, schema: "bad;drop" })).toThrow("Invalid PostgreSQL identifier");
    const store = new PostgresContextStore({ pool, vectorDimensions: 3 });
    await expect(store.searchPages("u1", [1, Number.NaN, 0], 2)).rejects.toThrow("non-finite");
  });

  it("batches writes and atomically leases durable enrichment jobs", async () => {
    const { pool, query } = fakePool();
    const store = new PostgresContextStore({ pool, vectorDimensions: 3 });
    const first = page([1, 0, 0]);
    const second = { ...page([0, 1, 0]), id: "p2", sequence: 2 };
    await store.savePages([first, second]);
    await store.saveThreads([thread([1, 0, 0])]);
    await store.appendTraces([
      { id: "trace-a", userId: "u1", sessionId: "s1", type: "page.created", at: first.createdAt, data: {} },
      { id: "trace-b", userId: "u1", sessionId: "s1", type: "page.completed", at: first.updatedAt, data: {} },
    ]);
    expect(query.mock.calls.slice(0, 3).every(([sql]) => String(sql).includes("jsonb_to_recordset"))).toBe(true);

    const at = new Date().toISOString();
    await store.enqueueEnrichment({ id: "job-1", userId: "u1", pageId: "p1", maxAttempts: 5, availableAt: at, createdAt: at, updatedAt: at });
    query.mockResolvedValueOnce({ rows: [{
      id: "job-1", user_id: "u1", page_id: "p1", status: "processing", attempts: 1, max_attempts: 5,
      available_at: at, lease_expires_at: at, worker_id: "worker-1", last_error: null, created_at: at, updated_at: at,
    }] });
    const claimed = await store.claimEnrichment({ userId: "u1", workerId: "worker-1", leaseMs: 30_000 });
    expect(claimed).toMatchObject({ id: "job-1", status: "processing", attempts: 1 });
    expect(String(query.mock.calls.at(-1)?.[0])).toContain("for update skip locked");
  });
});
