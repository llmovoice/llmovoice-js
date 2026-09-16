import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("LLMOVOICE_DEMO_ACCESS_TOKEN", "demo-secret");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(token = "demo-secret", text: unknown = "goal context") {
  return new Request("https://demo.example/api/embedding", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("embedding endpoint", () => {
  it("keeps the OpenAI key server-side and returns a fixed-dimension vector", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ embedding: [0.1, 0.2, 0.3] });
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/embeddings", expect.objectContaining({ method: "POST" }));
  });

  it("rejects unauthenticated and oversized requests", async () => {
    expect((await POST(request("wrong"))).status).toBe(401);
    expect((await POST(request("demo-secret", "x".repeat(8_001)))).status).toBe(400);
  });
});
