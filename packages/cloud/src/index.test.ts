import { describe, expect, it, vi } from "vitest";
import type { VoicePage } from "@llmovoice/core";
import { CloudContextStore } from "./index";

const at = "2026-07-22T00:00:00.000Z";
const page: VoicePage = {
  id: "page_1", userId: "user_1", sessionId: "session_1", sequence: 1, status: "complete",
  input: { modality: "text", transcript: "hello" }, summary: "hello", availableFidelities: ["transcript", "summary"],
  threadIds: [], metadata: {}, createdAt: at, updatedAt: at,
  state: {
    content: { topics: ["hello"], intent: "talk", explicitInstructions: [], entities: [] },
    style: { userWpm: 130, tone: "neutral" },
    environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: at },
    version: 1, observedAt: at,
  },
};

describe("CloudContextStore", () => {
  it("maps Pages to the managed API without exposing cross-user writes", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ accepted: 1 }, { status: 202 }));
    const store = new CloudContextStore({ apiKey: "lmv_dev_test_secret", userId: "user_1", baseUrl: "https://cloud.test", fetch: request });
    await store.savePage(page);
    const body = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(body.items[0]).toMatchObject({ id: "page_1", endUserId: "user_1", payload: page });
    await expect(store.savePage({ ...page, userId: "user_2" })).rejects.toThrow("cross-user");
  });

  it("turns a scoped 404 into a missing record", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "page_not_found", message: "missing" } }, { status: 404 }));
    const store = new CloudContextStore({ apiKey: "lmv_dev_test_secret", userId: "user_1", fetch: request });
    await expect(store.getPage("missing")).resolves.toBeNull();
  });
});
