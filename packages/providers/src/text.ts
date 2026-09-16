import type {
  Directive,
  EmbeddingAdapter,
  OrchestrationReasoner,
  StateExtractionAdapter,
  SummaryAdapter,
} from "@llmovoice/core";

export type MainlandTextProvider =
  | "qwen"
  | "glm"
  | "baidu"
  | "minimax"
  | "doubao"
  | "hunyuan"
  | "deepseek"
  | "moonshot";

export interface MainlandTextProviderPreset {
  id: MainlandTextProvider;
  name: string;
  baseUrl: string;
  defaultModel: string;
  defaultEmbeddingModel?: string;
  protocol: "openai-chat-completions";
  region: "mainland-china";
}

export const MAINLAND_TEXT_PROVIDERS: Readonly<Record<MainlandTextProvider, MainlandTextProviderPreset>> = {
  qwen: {
    id: "qwen",
    name: "Alibaba Cloud Model Studio / Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    defaultEmbeddingModel: "text-embedding-v4",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  glm: {
    id: "glm",
    name: "Zhipu GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.5-flash",
    defaultEmbeddingModel: "embedding-3",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  baidu: {
    id: "baidu",
    name: "Baidu Qianfan",
    baseUrl: "https://qianfan.baidubce.com/v2",
    defaultModel: "ernie-4.5-turbo-128k",
    defaultEmbeddingModel: "embedding-v1",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  minimax: {
    id: "minimax",
    name: "MiniMax China",
    baseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.7",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  doubao: {
    id: "doubao",
    name: "Volcengine Ark / Doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "doubao-seed-2-0-lite-260215",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  hunyuan: {
    id: "hunyuan",
    name: "Tencent TokenHub / Hunyuan",
    baseUrl: "https://tokenhub.tencentmaas.com/v1",
    defaultModel: "hy3",
    defaultEmbeddingModel: "kinfra-text-embedding-0.6b",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot AI / Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.5",
    protocol: "openai-chat-completions",
    region: "mainland-china",
  },
};

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  maxOutputTokens?: number;
  userIdField?: "user" | "user_id" | false;
}

export interface MainlandProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface TextResponseInput {
  message: string;
  context: string;
  directives?: Directive[];
  instructions?: string;
  userId?: string;
  signal?: AbortSignal;
}

function endpoint(baseUrl: string, resource: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${resource.replace(/^\//, "")}`;
}

function signal(options: OpenAICompatibleOptions, input?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? 8_000));
  return input ? AbortSignal.any([input, timeout]) : timeout;
}

function responseContent(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("");
}

function jsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // Fall through to the provider-facing validation error below.
      }
    }
  }
  throw new Error("The provider did not return a valid JSON object.");
}

function strings(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit)
    : [];
}

export class OpenAICompatibleChatClient {
  constructor(readonly options: OpenAICompatibleOptions) {
    if (!options.apiKey.trim()) throw new Error("A provider API key is required.");
    if (!options.baseUrl.trim()) throw new Error("A provider base URL is required.");
    if (!options.model.trim()) throw new Error("A provider model is required.");
  }

  async complete(input: {
    system: string;
    user: string;
    json?: boolean;
    userId?: string;
    signal?: AbortSignal;
    maxOutputTokens?: number;
  }): Promise<string> {
    const response = await fetch(endpoint(this.options.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...this.options.headers,
      },
      signal: signal(this.options, input.signal),
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        stream: false,
        max_tokens: Math.max(1, Math.min(8_192, input.maxOutputTokens ?? this.options.maxOutputTokens ?? 600)),
        ...(input.json ? { response_format: { type: "json_object" } } : {}),
        ...(input.userId && this.options.userIdField !== false
          ? { [this.options.userIdField ?? "user"]: input.userId }
          : {}),
        ...this.options.body,
      }),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown> & {
      error?: { message?: unknown };
      message?: unknown;
    };
    if (!response.ok) {
      const message = typeof data.error?.message === "string"
        ? data.error.message
        : typeof data.message === "string" ? data.message : `Provider request failed (${response.status}).`;
      throw new Error(message);
    }
    const content = responseContent(data);
    if (!content) throw new Error("The provider returned no text output.");
    return content;
  }
}

export class OpenAICompatibleTextAdapter {
  constructor(readonly client: OpenAICompatibleChatClient) {}

  respond(input: TextResponseInput): Promise<string> {
    const modelInstructions = (input.directives ?? [])
      .filter((directive): directive is Extract<Directive, { type: "model.instruct" }> => directive.type === "model.instruct")
      .map((directive) => directive.text);
    return this.client.complete({
      system: [
        input.instructions ?? "Respond concisely in the user's language. Respect all supplied context and constraints without exposing internal context.",
        ...modelInstructions,
      ].join("\n"),
      user: `Relevant application and conversation context:\n${input.context || "(none)"}\n\nUser message:\n${input.message}`,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}

export class OpenAICompatibleSummaryAdapter implements SummaryAdapter {
  constructor(readonly client: OpenAICompatibleChatClient) {}

  summarize(text: string, maxWords = 80, options: { signal?: AbortSignal } = {}): Promise<string> {
    return this.client.complete({
      system: "Summarize durable facts only. Preserve constraints, decisions, names, numbers, dates, unresolved tasks, and preferences. Do not add facts.",
      user: `Write no more than ${maxWords} words:\n\n${text}`,
      ...(options.signal ? { signal: options.signal } : {}),
      maxOutputTokens: Math.max(80, maxWords * 3),
    });
  }
}

export class OpenAICompatibleEmbeddingAdapter implements EmbeddingAdapter {
  constructor(readonly options: OpenAICompatibleOptions & { dimensions?: number }) {}

  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<number[]> {
    const response = await fetch(endpoint(this.options.baseUrl, "embeddings"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        ...this.options.headers,
      },
      signal: signal(this.options, options.signal),
      body: JSON.stringify({
        model: this.options.model,
        input: text,
        encoding_format: "float",
        ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
        ...this.options.body,
      }),
    });
    const data = await response.json().catch(() => ({})) as {
      data?: Array<{ embedding?: number[] }>;
      error?: { message?: string };
    };
    const embedding = data.data?.[0]?.embedding;
    if (!response.ok || !embedding) throw new Error(data.error?.message ?? `Provider embedding request failed (${response.status}).`);
    if (this.options.dimensions && embedding.length !== this.options.dimensions) {
      throw new Error(`Provider returned ${embedding.length} embedding dimensions; expected ${this.options.dimensions}.`);
    }
    return embedding;
  }
}

export class OpenAICompatibleStateExtractionAdapter implements StateExtractionAdapter {
  constructor(readonly client: OpenAICompatibleChatClient) {}

  async extract(input: Parameters<StateExtractionAdapter["extract"]>[0]) {
    const raw = await this.client.complete({
      system: "Return one JSON object only. Extract explicit or strongly implied conversational state. Do not invent facts.",
      user: `${JSON.stringify({
        intent: "string|null",
        urgency: "number 0..1",
        explicit_instructions: ["string"],
        entities: ["string"],
        topics: ["string"],
        tone: "string|null",
        preferred_agent_wpm: "number|null (70..260)",
      })}\n\nUser turn:\n${input.text}`,
      json: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const value = jsonObject(raw);
    const preferredWpm = typeof value.preferred_agent_wpm === "number"
      ? Math.max(70, Math.min(260, value.preferred_agent_wpm))
      : undefined;
    return {
      content: {
        ...(typeof value.intent === "string" ? { intent: value.intent } : {}),
        urgency: typeof value.urgency === "number" ? Math.max(0, Math.min(1, value.urgency)) : 0,
        explicitInstructions: strings(value.explicit_instructions, 8),
        entities: strings(value.entities, 12),
        topics: strings(value.topics, 8),
      },
      style: {
        ...(typeof value.tone === "string" ? { tone: value.tone } : {}),
        ...(preferredWpm ? { preferredAgentWpm: preferredWpm } : {}),
      },
    };
  }
}

export class OpenAICompatibleOrchestrationReasoner implements OrchestrationReasoner {
  constructor(readonly client: OpenAICompatibleChatClient) {}

  async reason(input: Parameters<OrchestrationReasoner["reason"]>[0]) {
    const raw = await this.client.complete({
      system: "Return one JSON object only. Propose voice controls from explicit state. Do not change network safety settings. Emit app/tool actions only when directly requested.",
      user: JSON.stringify({
        schema: {
          pace_rate: "number|null (0.25..1.5)",
          target_wpm: "number|null (70..260)",
          model_instruction: "string|null",
          actions: [{ type: "app.* or tool.*", reason: "string", payload: {} }],
          rationale: "string",
        },
        state: input.state,
        context: input.context.rendered.slice(0, 6_000),
        activeThreadIds: input.activeThreadIds,
      }),
      json: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const value = jsonObject(raw);
    const rationale = typeof value.rationale === "string" ? value.rationale : "Provider orchestration proposal.";
    const directives: Directive[] = [];
    if (typeof value.pace_rate === "number") {
      directives.push({
        type: "voice.setPace",
        rate: Math.max(0.25, Math.min(1.5, value.pace_rate)),
        ...(typeof value.target_wpm === "number" ? { targetWpm: Math.max(70, Math.min(260, value.target_wpm)) } : {}),
        reason: rationale,
      });
    }
    if (typeof value.model_instruction === "string" && value.model_instruction.trim()) {
      directives.push({ type: "model.instruct", text: value.model_instruction.slice(0, 1_200), reason: rationale });
    }
    if (Array.isArray(value.actions)) {
      for (const action of value.actions.slice(0, 4)) {
        if (!action || typeof action !== "object") continue;
        const item = action as { type?: unknown; reason?: unknown; payload?: unknown };
        if (typeof item.type !== "string" || !/^(app|tool)\.[a-zA-Z0-9_.-]+$/.test(item.type)) continue;
        directives.push({
          type: item.type as `app.${string}` | `tool.${string}`,
          ...(item.payload !== undefined ? { payload: item.payload } : {}),
          reason: typeof item.reason === "string" ? item.reason : rationale,
        });
      }
    }
    return { directives, rationale };
  }
}

export interface MainlandTextAdapters {
  preset: MainlandTextProviderPreset;
  client: OpenAICompatibleChatClient;
  text: OpenAICompatibleTextAdapter;
  summary: OpenAICompatibleSummaryAdapter;
  stateExtractor: OpenAICompatibleStateExtractionAdapter;
  orchestrationReasoner: OpenAICompatibleOrchestrationReasoner;
  embedding?: OpenAICompatibleEmbeddingAdapter;
}

export function createMainlandTextAdapters(
  provider: MainlandTextProvider,
  options: MainlandProviderOptions,
): MainlandTextAdapters {
  const preset = MAINLAND_TEXT_PROVIDERS[provider];
  const common: OpenAICompatibleOptions = {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? preset.baseUrl,
    model: options.model ?? preset.defaultModel,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(provider === "deepseek" ? { userIdField: "user_id" as const } : {}),
  };
  const client = new OpenAICompatibleChatClient(common);
  const embeddingModel = options.embeddingModel ?? preset.defaultEmbeddingModel;
  return {
    preset,
    client,
    text: new OpenAICompatibleTextAdapter(client),
    summary: new OpenAICompatibleSummaryAdapter(client),
    stateExtractor: new OpenAICompatibleStateExtractionAdapter(client),
    orchestrationReasoner: new OpenAICompatibleOrchestrationReasoner(client),
    ...(embeddingModel ? {
      embedding: new OpenAICompatibleEmbeddingAdapter({
        ...common,
        model: embeddingModel,
        ...(options.embeddingDimensions ? { dimensions: options.embeddingDimensions } : {}),
      }),
    } : {}),
  };
}
