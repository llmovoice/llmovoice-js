import { OpenAIEmbeddingAdapter } from "@llmovoice/openai";
import { authenticateDemoRequest } from "../../../lib/server-auth";

export const runtime = "nodejs";

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function POST(request: Request) {
  const identity = await authenticateDemoRequest(request);
  if (!identity) return json({ error: "Unauthorized" }, 401);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured." }, 503);
  let text = "";
  try {
    const body = await request.json() as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!text || text.length > 8_000) return json({ error: "text must contain 1–8000 characters." }, 400);

  try {
    const adapter = new OpenAIEmbeddingAdapter({
      apiKey,
      model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
      dimensions: 1536,
      timeoutMs: Math.max(500, Number(process.env.OPENAI_EMBEDDING_TIMEOUT_MS ?? 4_000)),
    });
    return json({ embedding: await adapter.embed(text, { signal: request.signal }) }, 200);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not create embedding." }, 502);
  }
}
