import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("LLMOVOICE_DEMO_ACCESS_TOKEN", "demo-secret");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_RATE_LIMIT_MAX", "5");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 123 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(input: { token?: string; origin?: string; ip?: string } = {}) {
  return new Request("https://demo.example/api/realtime/token", {
    method: "POST",
    headers: {
      host: "demo.example",
      origin: input.origin ?? "https://demo.example",
      "x-forwarded-for": input.ip ?? crypto.randomUUID(),
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
    },
  });
}

describe("Realtime token endpoint security", () => {
  it("fails closed in production without a valid access token", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request({ token: "wrong" }))).status).toBe(401);
  });

  it("rejects cross-origin requests", async () => {
    expect((await POST(request({ token: "demo-secret", origin: "https://attacker.example" }))).status).toBe(403);
  });

  it("mints no-store ephemeral credentials for authenticated callers", async () => {
    const response = await POST(request({ token: "demo-secret" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ value: "ek_test" });
  });

  it("accepts a verified Supabase access token when Supabase Auth is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "publishable-test");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/auth/v1/user")) return Response.json({ id: "auth-user-1", aud: "authenticated" });
      return Response.json({ value: "ek_supabase", expires_at: 123 });
    }));
    const response = await POST(request({ token: "supabase-jwt" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: "ek_supabase" });
  });

  it("rate limits repeated credential minting", async () => {
    vi.stubEnv("DEMO_RATE_LIMIT_MAX", "1");
    const ip = `rate-${crypto.randomUUID()}`;
    expect((await POST(request({ token: "demo-secret", ip }))).status).toBe(200);
    const limited = await POST(request({ token: "demo-secret", ip }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
