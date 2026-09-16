import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmovoice } from "@llmovoice/runtime";
import {
  BAIDU_REALTIME_PROFILE,
  GLM_REALTIME_PROFILE,
  MINIMAX_REALTIME_PROFILE,
  QWEN_REALTIME_PROFILE,
} from "./profiles";
import {
  createMainlandTextAdapters,
  MAINLAND_TEXT_PROVIDERS,
  OpenAICompatibleChatClient,
  OpenAICompatibleEmbeddingAdapter,
  OpenAICompatibleOrchestrationReasoner,
  OpenAICompatibleStateExtractionAdapter,
  OpenAICompatibleSummaryAdapter,
} from "./text";
import { MainlandRealtimeClient, type ProviderRealtimeSocket } from "./realtime";

afterEach(() => vi.unstubAllGlobals());

class FakeSocket extends EventEmitter implements ProviderRealtimeSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(event: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1006, "terminated");
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("mainland text providers", () => {
  it("ships explicit mainland endpoints for eight providers", () => {
    expect(Object.keys(MAINLAND_TEXT_PROVIDERS)).toEqual([
      "qwen", "glm", "baidu", "minimax", "doubao", "hunyuan", "deepseek", "moonshot",
    ]);
    for (const preset of Object.values(MAINLAND_TEXT_PROVIDERS)) {
      expect(preset.baseUrl).toMatch(/^https:\/\//);
      expect(preset.region).toBe("mainland-china");
    }
    expect(MAINLAND_TEXT_PROVIDERS.hunyuan).toMatchObject({
      baseUrl: "https://tokenhub.tencentmaas.com/v1",
      defaultModel: "hy3",
      defaultEmbeddingModel: "kinfra-text-embedding-0.6b",
    });
  });

  it("uses the OpenAI-compatible chat and embedding protocols", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/embeddings")) return jsonResponse({ data: [{ embedding: [0.2, 0.4] }] });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen-plus");
      expect(body.messages[1].content).toContain("User message");
      return jsonResponse({ choices: [{ message: { content: "可以，我们继续。" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapters = createMainlandTextAdapters("qwen", { apiKey: "sk-cn" });
    await expect(adapters.text.respond({ message: "继续", context: "目标：坚持训练" })).resolves.toBe("可以，我们继续。");
    await expect(adapters.embedding?.embed("训练目标")).resolves.toEqual([0.2, 0.4]);
  });

  it("extracts bounded state from JSON returned inside a code fence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "```json\n{\"intent\":\"plan\",\"urgency\":2,\"explicit_instructions\":[\"简短\"],\"entities\":[],\"topics\":[\"训练\"],\"tone\":\"calm\",\"preferred_agent_wpm\":999}\n```" } }],
    })));
    const client = new OpenAICompatibleChatClient({ apiKey: "key", baseUrl: "https://example.cn/v1", model: "model" });
    const state = await new OpenAICompatibleStateExtractionAdapter(client).extract({
      text: "请简短规划训练",
      current: {
        content: { explicitInstructions: [], entities: [], topics: [] },
        style: {},
        environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: "now" },
        version: 1,
        observedAt: "now",
      },
    });
    expect(state.content?.urgency).toBe(1);
    expect(state.style?.preferredAgentWpm).toBe(260);
  });

  it("surfaces provider error messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: { message: "quota exceeded" } }, 429)));
    const client = new OpenAICompatibleChatClient({ apiKey: "key", baseUrl: "https://example.cn/v1", model: "model" });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow("quota exceeded");
  });

  it("validates configuration and rejects empty provider output", async () => {
    expect(() => new OpenAICompatibleChatClient({ apiKey: "", baseUrl: "https://a.cn", model: "m" })).toThrow("API key");
    expect(() => new OpenAICompatibleChatClient({ apiKey: "k", baseUrl: "", model: "m" })).toThrow("base URL");
    expect(() => new OpenAICompatibleChatClient({ apiKey: "k", baseUrl: "https://a.cn", model: "" })).toThrow("model");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: [] } }] })));
    const client = new OpenAICompatibleChatClient({ apiKey: "k", baseUrl: "https://a.cn/", model: "m" });
    await expect(client.complete({ system: "s", user: "u" })).rejects.toThrow("no text output");
  });

  it("rejects embedding widths that do not match the configured vector index", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2] }] })));
    const adapters = createMainlandTextAdapters("qwen", {
      apiKey: "key",
      embeddingDimensions: 1_536,
    });
    await expect(adapters.embedding?.embed("dimension check")).rejects.toThrow(
      "returned 2 embedding dimensions; expected 1536",
    );
  });

  it("handles content parts, provider user-id differences, summary, and embedding errors", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (String(url).includes("embeddings")) return jsonResponse({ error: { message: "embedding unavailable" } }, 503);
      return jsonResponse({ choices: [{ message: { content: [{ text: "durable" }, { text: " summary" }] } }] });
    }));
    const adapters = createMainlandTextAdapters("deepseek", { apiKey: "k", maxOutputTokens: 200 });
    await expect(adapters.text.respond({ message: "hi", context: "ctx", userId: "hash-1" })).resolves.toBe("durable summary");
    expect(bodies[0]?.user_id).toBe("hash-1");
    expect(bodies[0]?.user).toBeUndefined();
    await expect(new OpenAICompatibleSummaryAdapter(adapters.client).summarize("turn", 10)).resolves.toBe("durable summary");
    const embedding = new OpenAICompatibleEmbeddingAdapter({ apiKey: "k", baseUrl: "https://a.cn/v1", model: "e" });
    await expect(embedding.embed("text")).rejects.toThrow("embedding unavailable");
  });

  it("maps structured orchestration proposals and filters unsafe actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: { content: JSON.stringify({
      pace_rate: 3,
      target_wpm: 20,
      model_instruction: "Be brief.",
      actions: [
        { type: "tool.calendar.lookup", reason: "requested", payload: { day: "Friday" } },
        { type: "http.delete_everything", reason: "unsafe" },
        null,
      ],
      rationale: "The user requested brevity.",
    }) } }] })));
    const reasoner = new OpenAICompatibleOrchestrationReasoner(
      new OpenAICompatibleChatClient({ apiKey: "k", baseUrl: "https://a.cn/v1", model: "m" }),
    );
    const result = await reasoner.reason({
      state: {
        content: { explicitInstructions: [], entities: [], topics: [] }, style: {},
        environment: { latencyMs: 0, jitterMs: 0, packetLoss: 0, connection: "stable", observedAt: "now" },
        version: 1, observedAt: "now",
      },
      context: {
        id: "c", query: "q", items: [], rendered: "context", estimatedTokens: 1, estimatedCostUsd: 0,
        trace: { candidateCount: 0, selectedCount: 0, droppedCount: 0, inputBudget: 10, usedTokens: 1, safetyTokens: 0, durationMs: 1, decisions: [] },
        createdAt: "now",
      },
      activeThreadIds: [],
    });
    expect(result.directives).toContainEqual(expect.objectContaining({ type: "voice.setPace", rate: 1.5, targetWpm: 70 }));
    expect(result.directives).toContainEqual(expect.objectContaining({ type: "model.instruct", text: "Be brief." }));
    expect(result.directives).toContainEqual(expect.objectContaining({ type: "tool.calendar.lookup" }));
    expect(result.directives).toHaveLength(3);
  });
});


describe("mainland realtime profiles", () => {
  it("validates realtime credentials", () => {
    expect(() => new MainlandRealtimeClient({
      provider: "qwen",
      apiKey: "",
      runtimeSession: createLlmovoice().createSession({ userId: "invalid" }),
    })).toThrow("API key");
  });

  it("builds provider-specific authenticated endpoints and declares limitations", () => {
    expect(QWEN_REALTIME_PROFILE.url({ apiKey: "k", workspaceId: "ws123456" })).toContain("ws123456.cn-beijing.maas.aliyuncs.com");
    expect(QWEN_REALTIME_PROFILE.defaultModel).toBe("qwen-audio-3.0-realtime-flash");
    expect(QWEN_REALTIME_PROFILE.inputSampleRate).toBe(16_000);
    expect(QWEN_REALTIME_PROFILE.sessionEvent({ apiKey: "k" }, "coach")).toMatchObject({
      session: { voice: "longanqian" },
    });
    expect(QWEN_REALTIME_PROFILE.capabilities.maturity).toBe("stable");
    expect(GLM_REALTIME_PROFILE.url({ apiKey: "k" })).toBe("wss://open.bigmodel.cn/api/paas/v4/realtime");
    expect(GLM_REALTIME_PROFILE.capabilities.maturity).toBe("stable");
    expect(BAIDU_REALTIME_PROFILE.capabilities.contextTiming).toBe("next-turn");
    expect(BAIDU_REALTIME_PROFILE.capabilities.manualTurnCommit).toBe(false);
    expect(BAIDU_REALTIME_PROFILE.capabilities.maturity).toBe("provider-managed");
    expect(MINIMAX_REALTIME_PROFILE.url({ apiKey: "k" })).toContain("api.minimax.chat/ws/v1/realtime");
    expect(MINIMAX_REALTIME_PROFILE.capabilities.maturity).toBe("legacy");
  });

  it("compiles Qwen context before explicitly creating the response", async () => {
    const session = createLlmovoice().createSession({ userId: "cn-user", sessionId: "cn-session" });
    const socket = new FakeSocket();
    const audio = vi.fn();
    const client = new MainlandRealtimeClient({
      provider: "qwen",
      apiKey: "sk-cn",
      runtimeSession: session,
      onAudioDelta: audio,
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    expect(socket.sent[0]).toMatchObject({ type: "session.update" });
    expect(JSON.stringify(socket.sent[0])).toContain('"turn_detection":null');
    client.appendAudio("YWJjZA==");
    client.commitAudio();
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_cn_user_1",
      transcript: "记住我的训练上限是每天三十分钟。",
    });
    await vi.waitFor(() => expect(socket.sent.some((event) => event.type === "response.create")).toBe(true));
    const contextUpdate = [...socket.sent].reverse().find((event) => event.type === "session.update");
    expect(JSON.stringify(contextUpdate)).toContain("每天三十分钟");
    socket.message({ type: "response.audio.delta", item_id: "assistant_1", delta: "YWJj" });
    socket.message({ type: "response.audio_transcript.done", item_id: "assistant_1", transcript: "我会记住。" });
    await vi.waitFor(async () => {
      expect((await session.snapshot()).pages[0]?.status).toBe("complete");
    });
    expect(audio).toHaveBeenCalledWith("YWJj", expect.objectContaining({ type: "response.audio.delta" }));
    expect(client.snapshot.contextTiming).toBe("before-response");
    expect(client.snapshot.maturity).toBe("stable");
    await client.close();
  });

  it("supports text turns and records usage across GLM realtime", async () => {
    const socket = new FakeSocket();
    const client = new MainlandRealtimeClient({
      provider: "glm",
      apiKey: "glm-key",
      runtimeSession: createLlmovoice().createSession({ userId: "u1" }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    await client.sendText("继续昨天的话题");
    expect(socket.sent.some((entry) => entry.type === "conversation.item.create")).toBe(true);
    expect(socket.sent.some((entry) => entry.type === "response.create")).toBe(true);
    socket.message({ type: "response.done", response: { usage: { input_tokens: 10, output_tokens: 4 } } });
    await vi.waitFor(() => expect(client.snapshot.inputTokens).toBe(10));
    expect(client.snapshot.outputTokens).toBe(4);
    await client.close();
  });

  it("prevents unsupported authoritative operations on Baidu realtime", async () => {
    const socket = new FakeSocket();
    const client = new MainlandRealtimeClient({
      provider: "baidu",
      apiKey: "baidu-key",
      runtimeSession: createLlmovoice().createSession({ userId: "u2" }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    expect(() => client.commitAudio()).toThrow("provider-managed VAD");
    await expect(client.sendText("hello")).rejects.toThrow("does not expose realtime text input");
    expect(client.snapshot.contextTiming).toBe("next-turn");
    await client.close();
  });

  it("maps tools, alternate usage fields, cancellation, and provider errors", async () => {
    const socket = new FakeSocket();
    const tool = vi.fn(async () => ({ ok: true }));
    const client = new MainlandRealtimeClient({
      provider: "qwen",
      apiKey: "key",
      runtimeSession: createLlmovoice().createSession({ userId: "u3" }),
      onToolCall: tool,
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    expect(() => client.appendAudio("not base64!" )).toThrow("base64");
    client.appendAudio("");
    await client.sendText("   ");
    socket.message({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "lookup",
      arguments: "{\"id\":1}",
    });
    socket.message({
      type: "response.done",
      usage: { prompt_tokens: 6, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
    });
    socket.message({ type: "response.cancelled" });
    socket.message({ type: "error", error: { code: "bad_request", message: "provider said no" } });
    await vi.waitFor(() => expect(tool).toHaveBeenCalledWith({ callId: "call-1", name: "lookup", arguments: { id: 1 } }));
    await vi.waitFor(() => expect(client.snapshot.inputTokens).toBe(6));
    expect(client.snapshot.cachedInputTokens).toBe(2);
    expect(client.snapshot.error).toBe("provider said no");
    expect(socket.sent.some((entry) => (entry.item as { type?: string } | undefined)?.type === "function_call_output")).toBe(true);
    client.cancelResponse();
    await client.close();
  });

  it("exercises profile overrides and reports unexpected disconnects", async () => {
    expect(QWEN_REALTIME_PROFILE.url({ apiKey: "k", baseUrl: "wss://custom.cn/realtime", model: "custom" }))
      .toBe("wss://custom.cn/realtime?model=custom");
    expect(BAIDU_REALTIME_PROFILE.url({ apiKey: "k", baseUrl: "wss://custom.cn/realtime?tenant=1", model: "audio" }))
      .toContain("&model=audio");
    expect(MINIMAX_REALTIME_PROFILE.url({ apiKey: "k", baseUrl: "wss://custom.cn/realtime?tenant=1", model: "audio" }))
      .toContain("&model=audio");
    expect(QWEN_REALTIME_PROFILE.deleteEvent?.("item-1")).toEqual({ type: "conversation.item.delete", item_id: "item-1" });
    expect(QWEN_REALTIME_PROFILE.paceEvent?.(1.2)).toEqual({ type: "session.update", session: { speed: 1.2 } });

    const socket = new FakeSocket();
    const onClose = vi.fn();
    const client = new MainlandRealtimeClient({
      provider: "minimax",
      apiKey: "key",
      runtimeSession: createLlmovoice().createSession({ userId: "u4" }),
      onClose,
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    socket.close(1011, "upstream-failed");
    await vi.waitFor(() => expect(client.snapshot.status).toBe("error"));
    expect(client.snapshot.error).toContain("upstream-failed");
    expect(onClose).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("handles subscriptions, string frames, malformed events, and duplicate audio deltas", async () => {
    const socket = new FakeSocket();
    const raw = vi.fn();
    const snapshots = vi.fn();
    const client = new MainlandRealtimeClient({
      provider: QWEN_REALTIME_PROFILE,
      apiKey: "key",
      runtimeSession: createLlmovoice().createSession({ userId: "u5" }),
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    const unsubscribeRaw = client.onRawEvent(raw);
    const unsubscribeSnapshot = client.subscribe(snapshots);
    await client.connect();
    await client.connect();
    socket.emit("message", JSON.stringify({ type: "response.text.delta", delta: "partial" }));
    socket.emit("message", JSON.stringify({ type: "response.text.done", item_id: "bad item id" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", delta: "YQ==" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.delta", delta: "Yg==" }));
    socket.emit("message", JSON.stringify({ type: "response.audio.done" }));
    socket.emit("message", JSON.stringify({ type: "error" }));
    socket.emit("message", "[]");
    await vi.waitFor(() => expect(raw).toHaveBeenCalled());
    await vi.waitFor(() => expect(client.snapshot.error).toContain("returned an error"));
    expect(snapshots).toHaveBeenCalled();
    unsubscribeRaw();
    unsubscribeSnapshot();
    await client.close();
    await client.close();
  });
});
