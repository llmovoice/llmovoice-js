import type { ConversationEvent, EnvironmentState, StateSnapshot } from "@llmovoice/core";
import { clamp } from "./utils";

function unique(values: string[], limit = 16): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(-limit);
}

function wordCount(text: string): number {
  const latin = text.match(/[\p{L}\p{N}'-]+/gu)?.length ?? 0;
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return latin + Math.ceil(cjk / 2);
}

function extractTopics(text: string): string[] {
  const stop = new Set(["this", "that", "with", "from", "have", "about", "please", "could", "would", "what", "when", "where", "帮我", "我们", "这个", "那个", "可以", "一下"]);
  return unique(
    (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}|[\p{Script=Han}]{2,6}/gu) ?? [])
      .filter((token) => !stop.has(token)),
    8,
  );
}

function heuristicExtraction(text: string): Partial<Pick<StateSnapshot, "content" | "style">> {
  const urgent = /urgent|asap|hurry|immediately|right now|紧急|马上|赶紧|尽快|快点/u.test(text);
  const careful = /careful|precise|detail|slowly|仔细|准确|详细|慢慢/u.test(text);
  const command = /\b(please|must|remember|do not|don't|never|always)\b|请|必须|不要|记住|务必/iu.test(text);
  const question = /[?？]|\b(what|why|how|when|where|which|can you|could you)\b|什么|为什么|怎么|如何|是否/u.test(text);
  const entities = unique([
    ...(text.match(/\b[A-Z][\p{L}\p{N}-]{1,}\b/gu) ?? []),
    ...(text.match(/(?:[$¥￥€£]\s?\d[\d,.]*|\b\d+(?:\.\d+)?(?:%|ms|s|min|hours?|days?|美元|元|分钟|小时|天)?\b)/gu) ?? []),
  ], 12);
  const tone = urgent ? "urgent" : careful ? "deliberate" : /[!！]{2,}/u.test(text) ? "animated" : "neutral";
  return {
    content: {
      intent: urgent ? "urgent-request" : command ? "instruction" : question ? "question" : "conversation",
      urgency: urgent ? 0.9 : careful ? 0.45 : 0.2,
      explicitInstructions: command || careful ? [text] : [],
      entities,
      topics: extractTopics(text),
    },
    style: { tone },
  };
}

export function createInitialState(at = new Date().toISOString()): StateSnapshot {
  return {
    content: {
      explicitInstructions: [],
      entities: [],
      topics: [],
    },
    style: {
      interruptionPattern: "normal",
    },
    environment: {
      latencyMs: 45,
      jitterMs: 8,
      packetLoss: 0,
      connection: "stable",
      observedAt: at,
    },
    version: 1,
    observedAt: at,
  };
}

export class StateReducer {
  private state: StateSnapshot;
  private speechStartedAtMs: number | null = null;
  private lastSpeechDurationMs: number | null = null;
  private interruptionCount = 0;

  constructor(initial?: StateSnapshot) {
    this.state = initial ? structuredClone(initial) : createInitialState();
  }

  get snapshot(): StateSnapshot {
    return structuredClone(this.state);
  }

  restore(snapshot: StateSnapshot): StateSnapshot {
    this.state = structuredClone(snapshot);
    this.speechStartedAtMs = null;
    this.lastSpeechDurationMs = null;
    this.interruptionCount = snapshot.style.interruptionPattern === "frequent" ? 3 : 0;
    return this.snapshot;
  }

  update(event: ConversationEvent): StateSnapshot {
    if (event.type === "user.speech.started") {
      this.speechStartedAtMs = new Date(event.at).getTime();
    }

    if (event.type === "user.speech.stopped" && this.speechStartedAtMs !== null) {
      this.lastSpeechDurationMs = Math.max(250, new Date(event.at).getTime() - this.speechStartedAtMs);
      this.speechStartedAtMs = null;
    }

    if (event.type === "user.transcript.completed") {
      const extracted = heuristicExtraction(event.text);
      const durationMs = event.audio?.durationMs ?? this.lastSpeechDurationMs ?? undefined;
      if (durationMs && durationMs > 0) {
        const measuredWpm = Math.round(wordCount(event.text) / (durationMs / 60_000));
        if (Number.isFinite(measuredWpm) && measuredWpm >= 45 && measuredWpm <= 320) {
          extracted.style = {
            ...extracted.style,
            userWpm: measuredWpm,
            preferredAgentWpm: this.state.style.preferredAgentWpm
              ? Math.round(this.state.style.preferredAgentWpm * 0.65 + measuredWpm * 0.35)
              : measuredWpm,
          };
        }
      }
      this.mergeExtraction(extracted, event.at);
      this.lastSpeechDurationMs = null;
    }

    if (event.type === "response.interrupted") {
      this.interruptionCount += 1;
      this.updateStyle({ interruptionPattern: this.interruptionCount >= 3 ? "frequent" : "normal" }, event.at);
    }

    if (event.type === "environment.updated") {
      const next: EnvironmentState = {
        ...this.state.environment,
        ...event.environment,
        latencyMs: Math.max(0, event.environment.latencyMs ?? this.state.environment.latencyMs),
        jitterMs: Math.max(0, event.environment.jitterMs ?? this.state.environment.jitterMs),
        packetLoss: clamp(event.environment.packetLoss ?? this.state.environment.packetLoss),
        observedAt: event.at,
      };
      if (next.connection !== "offline") {
        const degraded = next.latencyMs >= 300 || next.jitterMs >= 100 || next.packetLoss >= 0.04;
        next.connection = degraded ? "degraded" : "stable";
      }
      this.state = {
        ...this.state,
        environment: next,
        version: this.state.version + 1,
        observedAt: event.at,
      };
    }

    if (event.type === "session.disconnected") {
      this.state = {
        ...this.state,
        environment: {
          ...this.state.environment,
          connection: "offline",
          observedAt: event.at,
        },
        version: this.state.version + 1,
        observedAt: event.at,
      };
    }

    if (event.type === "session.connected") {
      this.state = {
        ...this.state,
        environment: {
          ...this.state.environment,
          connection: "stable",
          observedAt: event.at,
        },
        version: this.state.version + 1,
        observedAt: event.at,
      };
    }

    return this.snapshot;
  }

  updateContent(input: Partial<StateSnapshot["content"]>, at = new Date().toISOString()): StateSnapshot {
    this.state = {
      ...this.state,
      content: {
        ...this.state.content,
        ...input,
      },
      version: this.state.version + 1,
      observedAt: at,
    };
    return this.snapshot;
  }

  updateStyle(input: Partial<StateSnapshot["style"]>, at = new Date().toISOString()): StateSnapshot {
    this.state = {
      ...this.state,
      style: {
        ...this.state.style,
        ...input,
      },
      version: this.state.version + 1,
      observedAt: at,
    };
    return this.snapshot;
  }

  mergeExtraction(
    input: Partial<Pick<StateSnapshot, "content" | "style">>,
    at = new Date().toISOString(),
  ): StateSnapshot {
    this.state = {
      ...this.state,
      content: {
        ...this.state.content,
        ...input.content,
        explicitInstructions: unique([
          ...this.state.content.explicitInstructions,
          ...(input.content?.explicitInstructions ?? []),
        ]),
        entities: unique([...this.state.content.entities, ...(input.content?.entities ?? [])]),
        topics: unique([...this.state.content.topics, ...(input.content?.topics ?? [])]),
      },
      style: {
        ...this.state.style,
        ...input.style,
      },
      version: this.state.version + 1,
      observedAt: at,
    };
    return this.snapshot;
  }
}
