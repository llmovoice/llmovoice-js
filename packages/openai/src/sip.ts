export interface OpenAIRealtimeIncomingCall {
  eventId: string;
  callId: string;
  sipHeaders: Array<{ name: string; value: string }>;
  createdAt: number;
}

export interface OpenAISipControllerOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  safetyIdentifier?: string;
}

export interface AcceptSipCallOptions {
  model?: string;
  voice?: string;
  instructions: string;
  transcriptionModel?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  speed?: number;
  safetyIdentifier?: string;
  tools?: Array<Record<string, unknown>>;
}

export interface OpenAISipWebhookHandlerOptions {
  controller: OpenAISipController;
  verify(body: string, headers: Headers): unknown | Promise<unknown>;
  onIncomingCall(
    call: OpenAIRealtimeIncomingCall,
    controller: OpenAISipController,
  ): void | Promise<void>;
  claimEvent?: (eventId: string) => boolean | Promise<boolean>;
  maxBodyBytes?: number;
}

function callId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(value)) throw new Error("Invalid Realtime call ID.");
  return value;
}

async function callRequest(
  options: OpenAISipControllerOptions,
  id: string,
  action: "accept" | "reject" | "refer" | "hangup",
  body?: Record<string, unknown>,
  safetyIdentifier?: string,
): Promise<void> {
  if (!options.apiKey.trim()) throw new Error("An OpenAI API key is required.");
  const response = await fetch(`${options.baseUrl ?? "https://api.openai.com/v1"}/realtime/calls/${callId(id)}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      ...(safetyIdentifier ?? options.safetyIdentifier
        ? { "OpenAI-Safety-Identifier": safetyIdentifier ?? options.safetyIdentifier! }
        : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? `Realtime SIP ${action} failed (${response.status}).`);
  }
}

export function parseOpenAIRealtimeIncomingCall(event: unknown): OpenAIRealtimeIncomingCall | null {
  if (!event || typeof event !== "object") return null;
  const value = event as {
    id?: unknown;
    type?: unknown;
    created_at?: unknown;
    data?: { call_id?: unknown; sip_headers?: unknown };
  };
  if (value.type !== "realtime.call.incoming" || typeof value.id !== "string" || typeof value.data?.call_id !== "string") return null;
  const sipHeaders = Array.isArray(value.data.sip_headers)
    ? value.data.sip_headers.flatMap((header) => {
        if (!header || typeof header !== "object") return [];
        const item = header as { name?: unknown; value?: unknown };
        return typeof item.name === "string" && typeof item.value === "string" ? [{ name: item.name, value: item.value }] : [];
      })
    : [];
  return {
    eventId: value.id,
    callId: callId(value.data.call_id),
    sipHeaders,
    createdAt: typeof value.created_at === "number" ? value.created_at : 0,
  };
}

export class OpenAISipController {
  constructor(private readonly options: OpenAISipControllerOptions) {}

  accept(id: string, input: AcceptSipCallOptions): Promise<void> {
    return callRequest(this.options, id, "accept", {
      type: "realtime",
      model: input.model ?? "gpt-realtime-2.1",
      output_modalities: ["audio"],
      instructions: input.instructions,
      max_output_tokens: Math.max(1, Math.min(4_096, input.maxOutputTokens ?? 1_024)),
      truncation: {
        type: "retention_ratio",
        retention_ratio: 0.8,
        token_limits: {
          post_instructions: Math.max(1_000, input.maxInputTokens ?? 8_000),
        },
      },
      audio: {
        input: {
          transcription: { model: input.transcriptionModel ?? "gpt-4o-mini-transcribe" },
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 420,
            create_response: false,
            interrupt_response: true,
          },
        },
        output: {
          voice: input.voice ?? "marin",
          speed: Math.min(1.5, Math.max(0.25, input.speed ?? 1)),
        },
      },
      ...(input.tools ? { tools: input.tools } : {}),
    }, input.safetyIdentifier);
  }

  reject(id: string, statusCode = 603): Promise<void> {
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 699) throw new Error("Invalid SIP status code.");
    return callRequest(this.options, id, "reject", { status_code: statusCode });
  }

  refer(id: string, targetUri: string): Promise<void> {
    if (!/^(tel:|sip:)/i.test(targetUri)) throw new Error("SIP referrals require a tel: or sip: target URI.");
    return callRequest(this.options, id, "refer", { target_uri: targetUri });
  }

  hangup(id: string): Promise<void> {
    return callRequest(this.options, id, "hangup");
  }

  sidebandUrl(id: string): string {
    return `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId(id))}`;
  }
}

export function createOpenAISipWebhookHandler(options: OpenAISipWebhookHandlerOptions) {
  const maxBodyBytes = Math.max(1_024, Math.min(10_000_000, options.maxBodyBytes ?? 1_000_000));
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      return new Response("Payload too large", { status: 413 });
    }
    let body: string;
    try {
      body = await request.text();
    } catch {
      return new Response("Invalid request body", { status: 400 });
    }
    if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
      return new Response("Payload too large", { status: 413 });
    }

    let verified: unknown;
    try {
      verified = await options.verify(body, request.headers);
    } catch {
      return new Response("Invalid webhook signature", { status: 400 });
    }
    const call = parseOpenAIRealtimeIncomingCall(verified);
    if (!call) return new Response(null, { status: 204 });

    if (options.claimEvent && !await options.claimEvent(call.eventId)) {
      return Response.json({ received: true, duplicate: true });
    }
    try {
      await options.onIncomingCall(call, options.controller);
      return Response.json({ received: true });
    } catch {
      return Response.json({ error: "Incoming call handling failed." }, { status: 500 });
    }
  };
}
