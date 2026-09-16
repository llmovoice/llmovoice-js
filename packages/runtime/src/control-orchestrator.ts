import type {
  CompiledContext,
  Directive,
  OrchestrationReasoner,
  OrchestrationResult,
  StateSnapshot,
} from "@llmovoice/core";
import { withDeadline } from "./utils";

export interface ControlOrchestratorInput {
  state: StateSnapshot;
  context: CompiledContext;
  activeThreadIds?: string[];
  signal?: AbortSignal;
}

export interface ControlOrchestratorOptions {
  reasoner?: OrchestrationReasoner;
  reasoningTimeoutMs?: number;
}

function boundedDirective(directive: Directive): Directive | null {
  if (directive.type === "turn.setSilence") {
    return { ...directive, milliseconds: Math.round(Math.min(2_000, Math.max(200, directive.milliseconds))) };
  }
  if (directive.type === "voice.setPace") {
    return {
      ...directive,
      rate: Math.min(1.5, Math.max(0.25, directive.rate)),
      ...(directive.targetWpm ? { targetWpm: Math.min(260, Math.max(70, directive.targetWpm)) } : {}),
    };
  }
  if (directive.type === "model.instruct") {
    return { ...directive, text: directive.text.slice(0, 8_000) };
  }
  if (directive.type.startsWith("app.") || directive.type.startsWith("tool.")) return directive;
  if (["response.pause", "response.resume", "context.activateThread", "context.archiveThread"].includes(directive.type)) {
    return directive;
  }
  return null;
}

export class ControlOrchestrator {
  readonly policyVersion: string;
  private readonly reasoner: OrchestrationReasoner | undefined;
  private readonly reasoningTimeoutMs: number;

  constructor(options: ControlOrchestratorOptions = {}) {
    this.reasoner = options.reasoner;
    this.reasoningTimeoutMs = options.reasoningTimeoutMs ?? 350;
    this.policyVersion = options.reasoner ? "hybrid-llm-v2" : "deterministic-v2";
  }

  async decide(input: ControlOrchestratorInput): Promise<OrchestrationResult> {
    const startedAt = performance.now();
    const environment = input.state.environment;
    const activeThreadIds = input.activeThreadIds ?? [];
    const reasoned: Directive[] = [];

    if (this.reasoner) {
      try {
        const proposal = await withDeadline(
          (signal) => this.reasoner!.reason({ state: input.state, context: input.context, activeThreadIds, signal }),
          this.reasoningTimeoutMs,
          "orchestration-timeout",
          input.signal,
        );
        for (const directive of proposal.directives) {
          const bounded = boundedDirective(directive);
          if (bounded) reasoned.push(bounded);
        }
      } catch {
        // Deterministic policies below are the production fallback.
      }
    }

    const directives: Directive[] = reasoned.filter((directive) =>
      !["turn.setSilence", "response.pause", "response.resume", "voice.setPace"].includes(directive.type),
    );

    if (environment.connection === "offline") {
      directives.push({ type: "response.pause", reason: "Environment safety tier: connection is offline." });
    } else {
      directives.push({ type: "response.resume", reason: "Environment safety tier: connection can accept realtime output." });
      const rtt = environment.roundTripTimeMs ?? environment.latencyMs;
      const instability = rtt + environment.jitterMs * 1.8 + environment.packetLoss * 2_000;
      const silence = instability >= 900 ? 1_200 : instability >= 380 ? 800 : 320;
      directives.push({
        type: "turn.setSilence",
        milliseconds: silence,
        reason: `Environment safety tier overrides lower-priority controls (score ${Math.round(instability)}).`,
      });
    }

    const explicitCare = input.state.content.explicitInstructions.some((instruction) =>
      /slow|careful|detail|legal|precise|慢|仔细|详细|准确/u.test(instruction),
    );
    const reasonedPace = reasoned.find((directive) => directive.type === "voice.setPace");
    const targetWpm = explicitCare
      ? 125
      : reasonedPace?.type === "voice.setPace"
        ? reasonedPace.targetWpm
        : input.state.style.preferredAgentWpm ?? input.state.style.userWpm;
    if (targetWpm || reasonedPace?.type === "voice.setPace") {
      const rate = explicitCare
        ? 125 / 150
        : reasonedPace?.type === "voice.setPace"
          ? reasonedPace.rate
          : (targetWpm ?? 150) / 150;
      directives.push({
        type: "voice.setPace",
        rate: Math.min(1.5, Math.max(0.25, rate)),
        ...(targetWpm ? { targetWpm } : {}),
        reason: explicitCare
          ? "Content correctness tier overrides style matching."
          : reasonedPace?.type === "voice.setPace"
            ? `LLM proposal accepted below the environment and content safety tiers: ${reasonedPace.reason}`
            : "Style tier: conversational entrainment.",
      });
    }

    for (const threadId of activeThreadIds) {
      directives.push({
        type: "context.activateThread",
        threadId,
        reason: "Thread router selected this conversational locality.",
      });
    }

    if (input.context.rendered) {
      directives.push({
        type: "model.instruct",
        text: input.context.rendered,
        reason: `Context compiler selected ${input.context.items.length} bounded context items.`,
      });
    }

    return {
      directives,
      state: structuredClone(input.state),
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      policyVersion: this.policyVersion,
    };
  }
}
