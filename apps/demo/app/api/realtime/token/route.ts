import { createHash } from "node:crypto";
import { createOpenAIRealtimeClientSecret } from "@llmovoice/openai";
import { authenticateDemoRequest } from "../../../../lib/server-auth";

export const runtime = "nodejs";

const instructions = `You are the llmovoice demo assistant.
Respond naturally and concisely in the user's language.
Use the historical context supplied for each response when it is relevant.
Never mention internal context IDs, projection scores, or system implementation details unless the user asks about them.`;

const windows = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_IDENTITIES = 10_000;

function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

function clientAddress(request: Request): string {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] ?? request.headers.get("x-real-ip") ?? "local").trim();
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const expectedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try { return new URL(origin).host === expectedHost; } catch { return false; }
}

function withinRateLimit(key: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const durationMs = Math.max(60_000, Number(process.env.DEMO_RATE_LIMIT_WINDOW_MS ?? 600_000));
  const limit = Math.max(1, Number(process.env.DEMO_RATE_LIMIT_MAX ?? 5));
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    if (!current && windows.size >= MAX_RATE_LIMIT_IDENTITIES) {
      for (const [identity, window] of windows) {
        if (window.resetAt <= now) windows.delete(identity);
      }
      if (windows.size >= MAX_RATE_LIMIT_IDENTITIES) return { allowed: false, retryAfter: 60 };
    }
    windows.set(key, { count: 1, resetAt: now + durationMs });
    return { allowed: true, retryAfter: 0 };
  }
  if (current.count >= limit) return { allowed: false, retryAfter: Math.ceil((current.resetAt - now) / 1_000) };
  current.count += 1;
  return { allowed: true, retryAfter: 0 };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Cross-origin token requests are not allowed." }, 403);

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the demo server." }, 503);

  const identity = await authenticateDemoRequest(request);
  if (!identity) {
    return json({ error: "A valid demo access token is required." }, 401, { "WWW-Authenticate": "Bearer" });
  }

  const address = clientAddress(request);
  const safetyIdentifier = createHash("sha256").update(identity.userId).digest("hex");
  const rateIdentity = createHash("sha256").update(`${address}:${identity.userId}`).digest("hex");
  const rate = withinRateLimit(rateIdentity);
  if (!rate.allowed) return json({ error: "Realtime demo rate limit exceeded." }, 429, { "Retry-After": String(rate.retryAfter) });

  try {
    const secret = await createOpenAIRealtimeClientSecret({
      apiKey,
      model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1",
      voice: process.env.OPENAI_REALTIME_VOICE ?? "marin",
      instructions,
      safetyIdentifier: safetyIdentifier.slice(0, 64),
      expiresInSeconds: Math.max(60, Math.min(600, Number(process.env.OPENAI_REALTIME_TOKEN_TTL_SECONDS ?? 120))),
      maxOutputTokens: Math.max(64, Number(process.env.OPENAI_REALTIME_MAX_OUTPUT_TOKENS ?? 1_024)),
      maxInputTokens: Math.max(1_000, Number(process.env.OPENAI_REALTIME_MAX_INPUT_TOKENS ?? 8_000)),
      timeoutMs: Math.max(1_000, Number(process.env.OPENAI_REALTIME_TOKEN_TIMEOUT_MS ?? 8_000)),
      signal: request.signal,
    });
    return json({ value: secret.value, expiresAt: secret.expires_at }, 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not create a Realtime client secret." }, 502);
  }
}
