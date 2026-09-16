import { createHmac, timingSafeEqual } from "node:crypto";

export interface TwilioWebhookVerificationOptions {
  authToken: string;
  publicUrl?: string | ((request: Request) => string);
  maxBodyBytes?: number;
}

export interface TwilioWebhookPayload {
  url: string;
  params: Record<string, string>;
}

export interface TwilioWebhookIdempotency {
  claim(key: string): boolean | Promise<boolean>;
  complete?(key: string): void | Promise<void>;
  release?(key: string, error: unknown): void | Promise<void>;
}

export class MemoryTwilioWebhookIdempotency implements TwilioWebhookIdempotency {
  private readonly claims = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  claim(key: string): boolean {
    const now = Date.now();
    const existing = this.claims.get(key);
    if (existing && existing > now) return false;
    if (this.claims.size >= this.maxEntries) {
      for (const [entry, expiresAt] of this.claims) {
        if (expiresAt <= now) this.claims.delete(entry);
      }
      if (this.claims.size >= this.maxEntries) {
        const oldest = this.claims.keys().next().value as string | undefined;
        if (oldest) this.claims.delete(oldest);
      }
    }
    this.claims.set(key, now + Math.max(1_000, this.ttlMs));
    return true;
  }

  release(key: string): void {
    this.claims.delete(key);
  }
}

export class TwilioWebhookError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TwilioWebhookError";
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  if (!authToken.trim()) throw new Error("A Twilio Auth Token is required.");
  const data = Object.keys(params)
    .sort()
    .reduce((value, key) => `${value}${key}${params[key] ?? ""}`, url);
  return createHmac("sha1", authToken).update(data).digest("base64");
}

export async function verifyTwilioWebhook(
  request: Request,
  options: TwilioWebhookVerificationOptions,
): Promise<TwilioWebhookPayload> {
  if (request.method !== "POST") throw new TwilioWebhookError("Method not allowed", 405);
  if (!options.authToken.trim()) throw new TwilioWebhookError("Twilio webhook verification is not configured.", 500);
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new TwilioWebhookError("Unsupported Twilio webhook content type.", 415);
  }
  const maxBodyBytes = Math.max(1_024, Math.min(1_000_000, options.maxBodyBytes ?? 64_000));
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new TwilioWebhookError("Payload too large", 413);
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    throw new TwilioWebhookError("Payload too large", 413);
  }
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) params[key] = value;
  const url = typeof options.publicUrl === "function"
    ? options.publicUrl(request)
    : options.publicUrl ?? request.url;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TwilioWebhookError("Invalid public webhook URL.", 500);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
    throw new TwilioWebhookError("Twilio webhooks require an HTTPS public URL.", 500);
  }
  const received = request.headers.get("x-twilio-signature") ?? "";
  const expected = computeTwilioSignature(options.authToken, parsedUrl.toString(), params);
  if (!received || !safeEqual(received, expected)) {
    throw new TwilioWebhookError("Invalid Twilio webhook signature.", 403);
  }
  return { url: parsedUrl.toString(), params };
}

export function twilioWebhookErrorResponse(error: unknown): Response {
  if (error instanceof TwilioWebhookError) {
    return new Response(error.message, {
      status: error.status,
      headers: {
        ...(error.status === 405 ? { Allow: "POST" } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  return new Response("Twilio webhook handling failed.", {
    status: 500,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
