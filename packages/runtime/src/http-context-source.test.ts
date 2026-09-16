import { describe, expect, it, vi } from "vitest";
import { HttpContextSource } from "./http-context-source";

describe("HttpContextSource", () => {
  it("retrieves bounded authenticated application context without putting userId in the URL", async () => {
    const mockFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({ units: [
      { id: "goal-1", source: "coachgpt", content: "Launch the product", title: "Goal" },
      { id: "preference-1", source: "coachgpt", content: "Be concise" },
    ] }));
    const fetcher = mockFetch as unknown as typeof fetch;
    const source = new HttpContextSource({
      name: "coachgpt",
      endpoint: "/api/coaching/context-projection",
      headers: { Authorization: "Bearer session" },
      fetch: fetcher,
    });

    const units = await source.retrieve({ userId: "private-user-id", query: "launch", limit: 1 });
    expect(units).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/coaching/context-projection?q=launch&limit=1",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    expect(String(mockFetch.mock.calls[0]?.[0])).not.toContain("private-user-id");
  });
});
