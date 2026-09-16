import type {
  Directive,
  EmbeddingAdapter,
  OrchestrationReasoner,
  StateExtractionAdapter,
  SummaryAdapter,
} from "@llmovoice/core";

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

function responseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
  }).join("");
}

function requestSignal(options: OpenAIAdapterOptions, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? 8_000));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function responsesRequest(
  options: OpenAIAdapterOptions,
  input: string,
  schema?: { name: string; schema: Record<string, unknown> },
  signal?: AbortSignal,
  requestOptions: {
    instructions?: string;
    maxOutputTokens?: number;
    safetyIdentifier?: string;
  } = {},
): Promise<string> {
  if (!options.apiKey.trim()) throw new Error("An OpenAI API key is required.");
  const response = await fetch(`${options.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
    signal: requestSignal(options, signal),
    body: JSON.stringify({
      model: options.model ?? "gpt-5.6-luna",
      reasoning: { effort: "none" },
      input,
      max_output_tokens: Math.max(1, Math.min(4_096, requestOptions.maxOutputTokens ?? 600)),
      ...(requestOptions.instructions ? { instructions: requestOptions.instructions } : {}),
      ...(requestOptions.safetyIdentifier ? { safety_identifier: requestOptions.safetyIdentifier } : {}),
      ...(schema ? {
        text: {
          format: {
            type: "json_schema",
            name: schema.name,
            strict: true,
            schema: schema.schema,
          },
        },
      } : {}),
    }),
  });
  const data = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? `OpenAI Responses request failed (${response.status}).`);
  const text = responseText(data);
  if (!text) throw new Error("OpenAI Responses returned no text output.");
  return text;
}

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  constructor(private readonly options: OpenAIAdapterOptions & { dimensions?: number }) {}

  async embed(text: string, callOptions: { signal?: AbortSignal } = {}): Promise<number[]> {
    if (!this.options.apiKey.trim()) throw new Error("An OpenAI API key is required.");
    const response = await fetch(`${this.options.baseUrl ?? "https://api.openai.com/v1"}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      signal: requestSignal(this.options, callOptions.signal),
      body: JSON.stringify({
        model: this.options.model ?? "text-embedding-3-small",
        input: text,
        encoding_format: "float",
        ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
      }),
    });
    const data = await response.json() as { data?: Array<{ embedding?: number[] }>; error?: { message?: string } };
    const embedding = data.data?.[0]?.embedding;
    if (!response.ok || !embedding) {
      throw new Error(data.error?.message ?? `OpenAI embedding request failed (${response.status}).`);
    }
    return embedding;
  }
}

export class OpenAISummaryAdapter implements SummaryAdapter {
  constructor(private readonly options: OpenAIAdapterOptions) {}

  async summarize(text: string, maxWords = 80, callOptions: { signal?: AbortSignal } = {}): Promise<string> {
    return responsesRequest(
      this.options,
      `Summarize this voice interaction as durable factual memory in at most ${maxWords} words. Preserve constraints, decisions, names, numbers, dates, unresolved tasks, and user preferences. Do not add facts.\n\n${text}`,
      undefined,
      callOptions.signal,
    );
  }
}

export interface OpenAITextResponseOptions extends OpenAIAdapterOptions {
  instructions?: string;
  maxOutputTokens?: number;
  safetyIdentifier?: string;
}

export class OpenAITextResponseAdapter {
  constructor(private readonly options: OpenAITextResponseOptions) {}

  respond(input: {
    message: string;
    context: string;
    directives?: Directive[];
    safetyIdentifier?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const modelInstructions = (input.directives ?? [])
      .filter((directive): directive is Extract<Directive, { type: "model.instruct" }> => directive.type === "model.instruct")
      .map((directive) => directive.text);
    return responsesRequest(
      this.options,
      [
        "Relevant historical and application context:",
        input.context || "(none)",
        "User SMS:",
        input.message,
      ].join("\n\n"),
      undefined,
      input.signal,
      {
        instructions: [
          this.options.instructions ?? "Write one concise SMS reply in the user's language. Respect every relevant constraint. Do not mention internal context or system implementation.",
          ...modelInstructions,
        ].join("\n"),
        maxOutputTokens: this.options.maxOutputTokens ?? 400,
        ...(input.safetyIdentifier ?? this.options.safetyIdentifier
          ? { safetyIdentifier: input.safetyIdentifier ?? this.options.safetyIdentifier }
          : {}),
      },
    );
  }
}

const stateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    intent: { type: ["string", "null"] },
    urgency: { type: "number", minimum: 0, maximum: 1 },
    explicit_instructions: { type: "array", items: { type: "string" }, maxItems: 8 },
    entities: { type: "array", items: { type: "string" }, maxItems: 12 },
    topics: { type: "array", items: { type: "string" }, maxItems: 8 },
    tone: { type: ["string", "null"] },
    preferred_agent_wpm: { type: ["number", "null"], minimum: 70, maximum: 260 },
  },
  required: ["intent", "urgency", "explicit_instructions", "entities", "topics", "tone", "preferred_agent_wpm"],
};

export class OpenAIStateExtractionAdapter implements StateExtractionAdapter {
  constructor(private readonly options: OpenAIAdapterOptions) {}

  async extract({ text, signal }: Parameters<StateExtractionAdapter["extract"]>[0]) {
    const raw = await responsesRequest(
      this.options,
      `Extract only explicit or strongly implied conversational state from the user turn. Do not invent entities or instructions. Estimate urgency from 0 to 1. Return the requested JSON.\n\nUser turn:\n${text}`,
      { name: "llmovoice_state", schema: stateSchema },
      signal,
    );
    const value = JSON.parse(raw) as {
      intent: string | null;
      urgency: number;
      explicit_instructions: string[];
      entities: string[];
      topics: string[];
      tone: string | null;
      preferred_agent_wpm: number | null;
    };
    return {
      content: {
        ...(value.intent ? { intent: value.intent } : {}),
        urgency: value.urgency,
        explicitInstructions: value.explicit_instructions,
        entities: value.entities,
        topics: value.topics,
      },
      style: {
        ...(value.tone ? { tone: value.tone } : {}),
        ...(value.preferred_agent_wpm ? { preferredAgentWpm: value.preferred_agent_wpm } : {}),
      },
    };
  }
}

const orchestrationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pace_rate: { type: ["number", "null"], minimum: 0.25, maximum: 1.5 },
    target_wpm: { type: ["number", "null"], minimum: 70, maximum: 260 },
    model_instruction: { type: ["string", "null"], maxLength: 1200 },
    actions: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", pattern: "^(app|tool)\\.[a-zA-Z0-9_.-]+$" },
          reason: { type: "string", maxLength: 300 },
          payload_json: { type: "string", maxLength: 2000 },
        },
        required: ["type", "reason", "payload_json"],
      },
    },
    rationale: { type: "string", maxLength: 500 },
  },
  required: ["pace_rate", "target_wpm", "model_instruction", "actions", "rationale"],
};

export class OpenAIOrchestrationReasoner implements OrchestrationReasoner {
  constructor(private readonly options: OpenAIAdapterOptions) {}

  async reason(input: Parameters<OrchestrationReasoner["reason"]>[0]) {
    const raw = await responsesRequest(
      this.options,
      `Propose best-effort voice controls from the supplied state. Do not propose network safety or VAD values; the deterministic compiler owns those. Explicit content requirements override acoustic style. Only emit app/tool actions when directly requested by the user.\n\n${JSON.stringify({ state: input.state, context: input.context.rendered.slice(0, 6_000), activeThreadIds: input.activeThreadIds })}`,
      { name: "llmovoice_orchestration", schema: orchestrationSchema },
      input.signal,
    );
    const value = JSON.parse(raw) as {
      pace_rate: number | null;
      target_wpm: number | null;
      model_instruction: string | null;
      actions: Array<{ type: string; reason: string; payload_json: string }>;
      rationale: string;
    };
    const directives: Directive[] = [];
    if (value.pace_rate !== null) {
      directives.push({
        type: "voice.setPace",
        rate: value.pace_rate,
        ...(value.target_wpm !== null ? { targetWpm: value.target_wpm } : {}),
        reason: value.rationale,
      });
    }
    if (value.model_instruction) {
      directives.push({ type: "model.instruct", text: value.model_instruction, reason: value.rationale });
    }
    for (const action of value.actions) {
      if (!/^(app|tool)\.[a-zA-Z0-9_.-]+$/.test(action.type)) continue;
      let payload: unknown;
      try { payload = JSON.parse(action.payload_json); } catch { payload = action.payload_json; }
      directives.push({
        type: action.type as `app.${string}` | `tool.${string}`,
        payload,
        reason: action.reason,
      });
    }
    return { directives, rationale: value.rationale };
  }
}
