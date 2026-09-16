import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIEmbeddingAdapter,
  OpenAIOrchestrationReasoner,
  OpenAIStateExtractionAdapter,
  OpenAISummaryAdapter,
  OpenAITextResponseAdapter,
} from "./adapters";
import { createOpenAIRealtimeClientSecret } from "./server";
import { createOpenAISipWebhookHandler, OpenAISipController, parseOpenAIRealtimeIncomingCall } from "./sip";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("OpenAI server adapters", () => {
  it("creates a bounded Realtime client secret", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.session.max_output_tokens).toBe(512);
      expect(body.session.truncation.token_limits.post_instructions).toBe(4_000);
      expect(body.session.audio.input.turn_detection.create_response).toBe(false);
      return jsonResponse({ value: "ek_test", expires_at: 123 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const secret = await createOpenAIRealtimeClientSecret({ apiKey: "sk-test", maxOutputTokens: 512, maxInputTokens: 4_000 });
    expect(secret.value).toBe("ek_test");
  });

  it("uses the low-latency GPT-5.6 family role for summaries", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.reasoning.effort).toBe("none");
      return jsonResponse({ output: [{ content: [{ type: "output_text", text: "durable summary" }] }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(new OpenAISummaryAdapter({ apiKey: "sk-test" }).summarize("hello")).resolves.toBe("durable summary");
  });

  it("extracts structured state and orchestration directives", async () => {
    const responses = [
      { intent: "booking", urgency: 0.7, explicit_instructions: ["under $200"], entities: ["$200"], topics: ["hotel"], tone: "urgent", preferred_agent_wpm: 180 },
      { pace_rate: 1.2, target_wpm: 180, model_instruction: "Keep it brief.", actions: [{ type: "tool.hotel.search", reason: "asked", payload_json: "{\"city\":\"YVR\"}" }], rationale: "User asked for speed." },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ output: [{ content: [{ text: JSON.stringify(responses.shift()) }] }] })));
    const state = await new OpenAIStateExtractionAdapter({ apiKey: "sk-test" }).extract({
      text: "Find a hotel", current: {
        content: { explicitInstructions: [], entities: [], topics: [] }, style: {},
        environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: "now" },
        version: 1, observedAt: "now",
      },
    });
    expect(state.content?.intent).toBe("booking");
    const orchestration = await new OpenAIOrchestrationReasoner({ apiKey: "sk-test" }).reason({
      state: {
        content: { explicitInstructions: [], entities: [], topics: [] }, style: {},
        environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: "now" },
        version: 1, observedAt: "now",
      },
      context: {
        id: "c", query: "q", items: [], rendered: "", estimatedTokens: 0, estimatedCostUsd: 0,
        trace: { candidateCount: 0, selectedCount: 0, droppedCount: 0, inputBudget: 1, usedTokens: 0, safetyTokens: 0, durationMs: 0, decisions: [] },
        createdAt: "now",
      },
      activeThreadIds: [],
    });
    expect(orchestration.directives.some((directive) => directive.type === "voice.setPace")).toBe(true);
    expect(orchestration.directives.some((directive) => directive.type === "tool.hotel.search")).toBe(true);
  });

  it("embeds content through the configured embedding endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] })));
    await expect(new OpenAIEmbeddingAdapter({ apiKey: "sk-test", dimensions: 3 }).embed("hotel")).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it("generates an SMS-sized reply from compiled context and model directives", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.input).toContain("User SMS:\n\nCan we move it?");
      expect(body.input).toContain("Appointment: Friday at 3pm");
      expect(body.instructions).toContain("Keep the answer under two sentences.");
      expect(body.max_output_tokens).toBe(240);
      expect(body.safety_identifier).toBe("user_hash_123");
      return jsonResponse({ output_text: "Yes — what time works better?" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAITextResponseAdapter({ apiKey: "sk-test", maxOutputTokens: 240 });
    await expect(adapter.respond({
      message: "Can we move it?",
      context: "Appointment: Friday at 3pm",
      directives: [{
        type: "model.instruct",
        text: "Keep the answer under two sentences.",
        reason: "SMS delivery limit",
      }],
      safetyIdentifier: "user_hash_123",
    })).resolves.toBe("Yes — what time works better?");
  });
});

describe("OpenAI SIP control", () => {
  it("parses incoming calls and invokes the official accept endpoint", async () => {
    const incoming = parseOpenAIRealtimeIncomingCall({
      id: "evt_123", type: "realtime.call.incoming", created_at: 1,
      data: { call_id: "rtc_12345678", sip_headers: [{ name: "From", value: "sip:+1555@example.com" }] },
    });
    expect(incoming?.callId).toBe("rtc_12345678");
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAISipController({ apiKey: "sk-test" }).accept("rtc_12345678", { instructions: "Answer politely." });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/realtime/calls/rtc_12345678/accept");
  });

  it("rejects unsafe SIP identifiers and referral targets", async () => {
    const controller = new OpenAISipController({ apiKey: "sk-test" });
    expect(() => controller.sidebandUrl("../bad")).toThrow("Invalid");
    expect(() => controller.refer("rtc_12345678", "https://example.com")).toThrow("tel: or sip:");
  });

  it("requires verification and supports idempotent framework-neutral webhook handling", async () => {
    const controller = new OpenAISipController({ apiKey: "server-key" });
    const handled: string[] = [];
    const handler = createOpenAISipWebhookHandler({
      controller,
      verify(body) {
        if (body === "bad") throw new Error("signature mismatch");
        return JSON.parse(body);
      },
      claimEvent: async (eventId) => eventId !== "evt_duplicate",
      onIncomingCall: async (call) => { handled.push(call.callId); },
    });
    const event = (id: string) => JSON.stringify({
      id,
      type: "realtime.call.incoming",
      created_at: 1,
      data: { call_id: "call_12345678", sip_headers: [] },
    });
    expect((await handler(new Request("https://example.com/webhook", { method: "POST", body: "bad" }))).status).toBe(400);
    expect((await handler(new Request("https://example.com/webhook", { method: "POST", body: event("evt_duplicate") }))).status).toBe(200);
    expect((await handler(new Request("https://example.com/webhook", { method: "POST", body: event("evt_unique") }))).status).toBe(200);
    expect(handled).toEqual(["call_12345678"]);
  });
});
