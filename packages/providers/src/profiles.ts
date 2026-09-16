export type MainlandRealtimeProvider = "qwen" | "glm" | "baidu" | "minimax";

export interface RealtimeProviderCapabilities {
  realtimeAudio: true;
  maturity: "stable" | "provider-managed" | "legacy";
  textInput: boolean;
  manualTurnCommit: boolean;
  contextTiming: "before-response" | "next-turn";
  functionCalling: boolean;
  conversationDelete: boolean;
  browserDirect: false;
}

export interface RealtimeProviderConnection {
  apiKey: string;
  model?: string;
  voice?: string;
  baseInstructions?: string;
  baseUrl?: string;
  workspaceId?: string;
  headers?: Record<string, string>;
  session?: Record<string, unknown>;
}

export interface RealtimeProviderProfile {
  id: MainlandRealtimeProvider;
  name: string;
  defaultModel: string;
  inputSampleRate: number;
  outputSampleRate: number;
  capabilities: RealtimeProviderCapabilities;
  url(options: RealtimeProviderConnection): string;
  headers(options: RealtimeProviderConnection): Record<string, string>;
  sessionEvent(options: RealtimeProviderConnection, instructions: string): Record<string, unknown>;
  audioEvent(base64Audio: string): Record<string, unknown>;
  commitEvent?(): Record<string, unknown>;
  textEvent?(text: string, itemId: string): Record<string, unknown>;
  preparedEvents(instructions: string): Record<string, unknown>[];
  cancelEvent(): Record<string, unknown>;
  deleteEvent?(itemId: string): Record<string, unknown>;
  paceEvent?(rate: number): Record<string, unknown>;
  silenceEvent?(milliseconds: number): Record<string, unknown>;
}

function auth(options: RealtimeProviderConnection): Record<string, string> {
  return { Authorization: `Bearer ${options.apiKey}`, ...options.headers };
}

function qwenUrl(options: RealtimeProviderConnection): string {
  if (options.baseUrl) return `${options.baseUrl.replace(/\/$/, "")}?model=${encodeURIComponent(options.model ?? "qwen-audio-3.0-realtime-flash")}`;
  const host = options.workspaceId
    ? `${options.workspaceId}.cn-beijing.maas.aliyuncs.com`
    : "dashscope.aliyuncs.com";
  return `wss://${host}/api-ws/v1/realtime?model=${encodeURIComponent(options.model ?? "qwen-audio-3.0-realtime-flash")}`;
}

export const QWEN_REALTIME_PROFILE: RealtimeProviderProfile = {
  id: "qwen",
  name: "Qwen-Audio Realtime",
  defaultModel: "qwen-audio-3.0-realtime-flash",
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  capabilities: {
    realtimeAudio: true,
    maturity: "stable",
    textInput: true,
    manualTurnCommit: true,
    contextTiming: "before-response",
    functionCalling: true,
    conversationDelete: true,
    browserDirect: false,
  },
  url: qwenUrl,
  headers(options) {
    return {
      ...auth(options),
      ...(options.workspaceId ? { "X-DashScope-WorkSpace": options.workspaceId } : {}),
      "User-Agent": "llmovoice.js/0.1",
    };
  },
  sessionEvent(options, instructions) {
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: options.voice ?? "longanqian",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: null,
        ...options.session,
      },
    };
  },
  audioEvent: (audio) => ({ type: "input_audio_buffer.append", audio }),
  commitEvent: () => ({ type: "input_audio_buffer.commit" }),
  textEvent: (text, itemId) => ({
    type: "conversation.item.create",
    item: { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text }] },
  }),
  preparedEvents: (instructions) => [
    { type: "session.update", session: { instructions } },
    { type: "response.create", response: { modalities: ["audio", "text"] } },
  ],
  cancelEvent: () => ({ type: "response.cancel" }),
  deleteEvent: (itemId) => ({ type: "conversation.item.delete", item_id: itemId }),
  paceEvent: (rate) => ({ type: "session.update", session: { speed: rate } }),
};

function event(type: string, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_id: crypto.randomUUID(), client_timestamp: Date.now(), type, ...rest };
}

export const GLM_REALTIME_PROFILE: RealtimeProviderProfile = {
  id: "glm",
  name: "GLM-Realtime",
  defaultModel: "glm-realtime",
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  capabilities: {
    realtimeAudio: true,
    maturity: "stable",
    textInput: true,
    manualTurnCommit: true,
    contextTiming: "before-response",
    functionCalling: true,
    conversationDelete: true,
    browserDirect: false,
  },
  url: (options) => options.baseUrl ?? "wss://open.bigmodel.cn/api/paas/v4/realtime",
  headers: auth,
  sessionEvent(options, instructions) {
    return event("session.update", {
      session: {
        model: options.model ?? "glm-realtime",
        modalities: ["audio", "text"],
        instructions,
        voice: options.voice ?? "tongtong",
        input_audio_format: "pcm",
        output_audio_format: "pcm",
        input_audio_noise_reduction: { type: "near_field" },
        turn_detection: { type: "client_vad" },
        beta_fields: { chat_mode: "audio", tts_source: "e2e" },
        ...options.session,
      },
    });
  },
  audioEvent: (audio) => event("input_audio_buffer.append", { audio }),
  commitEvent: () => event("input_audio_buffer.commit"),
  textEvent: (text, itemId) => event("conversation.item.create", {
    item: { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text }] },
  }),
  preparedEvents: (instructions) => [
    event("session.update", { session: { instructions } }),
    event("response.create"),
  ],
  cancelEvent: () => event("response.cancel"),
  deleteEvent: (itemId) => event("conversation.item.delete", { item_id: itemId }),
  paceEvent: (rate) => event("session.update", { session: { speed: rate } }),
};

export const BAIDU_REALTIME_PROFILE: RealtimeProviderProfile = {
  id: "baidu",
  name: "Baidu End-to-End Speech Language Model",
  defaultModel: "audio-realtime-near",
  inputSampleRate: 16_000,
  outputSampleRate: 24_000,
  capabilities: {
    realtimeAudio: true,
    maturity: "provider-managed",
    textInput: false,
    manualTurnCommit: false,
    contextTiming: "next-turn",
    functionCalling: false,
    conversationDelete: false,
    browserDirect: false,
  },
  url(options) {
    const base = options.baseUrl ?? "wss://aip.baidubce.com/ws/2.0/speech/v1/realtime";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}model=${encodeURIComponent(options.model ?? "audio-realtime-near")}`;
  },
  headers: auth,
  sessionEvent(options, instructions) {
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: instructions.slice(0, 2_500),
        voice: options.voice ?? "default",
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "default" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 300,
          create_response: true,
          interrupt_response: true,
        },
        ...options.session,
      },
    };
  },
  audioEvent: (audio) => ({ type: "input_audio_buffer.append", audio }),
  preparedEvents: (instructions) => [{
    type: "session.update",
    session: { instructions: instructions.slice(0, 2_500) },
  }],
  cancelEvent: () => ({ type: "response.cancel" }),
};

export const MINIMAX_REALTIME_PROFILE: RealtimeProviderProfile = {
  id: "minimax",
  name: "MiniMax Realtime",
  defaultModel: "abab6.5s-chat",
  inputSampleRate: 24_000,
  outputSampleRate: 24_000,
  capabilities: {
    realtimeAudio: true,
    maturity: "legacy",
    textInput: true,
    manualTurnCommit: true,
    contextTiming: "before-response",
    functionCalling: false,
    conversationDelete: true,
    browserDirect: false,
  },
  url(options) {
    const base = options.baseUrl ?? "wss://api.minimax.chat/ws/v1/realtime";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}model=${encodeURIComponent(options.model ?? "abab6.5s-chat")}`;
  },
  headers: auth,
  sessionEvent(options, instructions) {
    return {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions,
        voice: options.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: null,
        ...options.session,
      },
    };
  },
  audioEvent: (audio) => ({ type: "input_audio_buffer.append", audio }),
  commitEvent: () => ({ type: "input_audio_buffer.commit" }),
  textEvent: (text, itemId) => ({
    type: "conversation.item.create",
    item: { id: itemId, type: "message", role: "user", content: [{ type: "input_text", text }] },
  }),
  preparedEvents: (instructions) => [
    { type: "session.update", session: { instructions } },
    { type: "response.create", response: { modalities: ["audio", "text"] } },
  ],
  cancelEvent: () => ({ type: "response.cancel" }),
  deleteEvent: (itemId) => ({ type: "conversation.item.delete", item_id: itemId }),
};

export const MAINLAND_REALTIME_PROFILES: Readonly<Record<MainlandRealtimeProvider, RealtimeProviderProfile>> = {
  qwen: QWEN_REALTIME_PROFILE,
  glm: GLM_REALTIME_PROFILE,
  baidu: BAIDU_REALTIME_PROFILE,
  minimax: MINIMAX_REALTIME_PROFILE,
};

export function realtimeProviderProfile(provider: MainlandRealtimeProvider): RealtimeProviderProfile {
  return MAINLAND_REALTIME_PROFILES[provider];
}
