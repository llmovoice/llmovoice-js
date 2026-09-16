import { describe, expect, it } from "vitest";
import type { EnrichmentJob, EnrichmentQueue, OrchestrationReasoner, StateSnapshot, VoicePage } from "@llmovoice/core";
import { ContextCompiler } from "./context-compiler";
import { ControlOrchestrator } from "./control-orchestrator";
import { MemoryContextStore } from "./memory-store";
import { createLlmovoice } from "./runtime";
import { createInitialState, StateReducer } from "./state-reducer";
import { ThreadRouter } from "./thread-router";

function completePage(input: Partial<VoicePage> & Pick<VoicePage, "id">): VoicePage {
  const at = input.createdAt ?? new Date().toISOString();
  return {
    id: input.id,
    userId: input.userId ?? "u1",
    sessionId: input.sessionId ?? "s1",
    sequence: input.sequence ?? 1,
    status: "complete",
    input: input.input ?? { modality: "text", transcript: "test page", completedAt: at },
    output: input.output ?? { modality: "text", transcript: "acknowledged", completedAt: at },
    summary: input.summary ?? input.input?.transcript ?? "test page",
    state: input.state ?? createInitialState(at),
    availableFidelities: input.availableFidelities ?? ["transcript", "summary", "drop"],
    threadIds: input.threadIds ?? [],
    metadata: input.metadata ?? {},
    createdAt: at,
    updatedAt: input.updatedAt ?? at,
    ...(input.embedding ? { embedding: input.embedding } : {}),
  };
}

describe("advanced thread lifecycle", () => {
  it("recovers scattered historical pages when spawning a new thread", async () => {
    const store = new MemoryContextStore();
    const old = completePage({
      id: "old-preference",
      input: { modality: "text", transcript: "I strongly prefer spicy hotpot with numbing chili" },
      summary: "spicy hotpot numbing chili preference",
    });
    await store.savePage(old);
    const current = completePage({
      id: "restaurant-request",
      sequence: 2,
      input: { modality: "text", transcript: "Recommend dinner using my spicy hotpot preference" },
      summary: "restaurant recommendation spicy hotpot preference",
    });
    const result = await new ThreadRouter(store).route(current);
    expect(result.operation).toBe("spawn");
    expect(result.threads[0]?.pageIds).toEqual(["old-preference", "restaurant-request"]);
    expect((await store.getPage("old-preference"))?.threadIds).toContain(result.threads[0]?.id);
  });

  it("archives a thread and records the lifecycle trace", async () => {
    const store = new MemoryContextStore();
    const router = new ThreadRouter(store);
    const created = await router.route(completePage({ id: "page-archive" }));
    const archived = await router.archive("u1", created.threads[0]!.id, "s1");
    expect(archived.status).toBe("archived");
    expect((await store.listTraces("s1")).some((trace) => trace.type === "thread.archived")).toBe(true);
  });
});

describe("automatic state modeling", () => {
  it("extracts intent, urgency, instructions, tone, and speaking rate", () => {
    const reducer = new StateReducer();
    reducer.update({ type: "user.speech.started", at: "2026-01-01T00:00:00.000Z" });
    reducer.update({ type: "user.speech.stopped", at: "2026-01-01T00:00:06.000Z" });
    const state = reducer.update({
      type: "user.transcript.completed",
      text: "Please hurry and remember the hotel must allow dogs",
      at: "2026-01-01T00:00:06.100Z",
    });
    expect(state.content.intent).toBe("urgent-request");
    expect(state.content.urgency).toBeGreaterThan(0.8);
    expect(state.content.explicitInstructions).toHaveLength(1);
    expect(state.style.tone).toBe("urgent");
    expect(state.style.userWpm).toBeGreaterThanOrEqual(45);
  });
});

describe("multi-fidelity projection", () => {
  it("keeps provider-native audio for a style-sensitive query when budget allows", async () => {
    const store = new MemoryContextStore();
    await store.savePage(completePage({
      id: "audio-page",
      input: {
        modality: "audio",
        transcript: "Use this same calm speaking style",
        audio: { uri: "realtime://s1/input/item1", durationMs: 4_000, persisted: false },
      },
      summary: "The user spoke calmly.",
      availableFidelities: ["audio", "transcript", "summary", "drop"],
    }));
    const compiler = new ContextCompiler(store, [], {
      budget: { maxInputTokens: 1_000, reservedOutputTokens: 100 },
      costModel: { audioTokensPerSecond: 10, textTokensPerWord: 1.33 },
      maxCandidates: 10,
      minRelevance: 0,
    });
    const result = await compiler.compile({ userId: "u1", query: "match that voice pace and style", state: createInitialState() });
    expect(result.items[0]?.fidelity).toBe("audio");
    expect(result.items[0]?.audio?.uri).toContain("realtime://");
  });
});

describe("hybrid orchestration", () => {
  it("accepts bounded LLM proposals but preserves the environment safety tier", async () => {
    const reasoner: OrchestrationReasoner = {
      async reason() {
        return { directives: [
          { type: "turn.setSilence", milliseconds: 200, reason: "fast" },
          { type: "voice.setPace", rate: 4, targetWpm: 500, reason: "requested" },
          { type: "model.instruct", text: "Ask one concise follow-up.", reason: "missing detail" },
          { type: "tool.lookup", payload: { id: 1 }, reason: "explicit request" },
        ] };
      },
    };
    const state: StateSnapshot = createInitialState();
    state.environment = { latencyMs: 700, jitterMs: 250, packetLoss: 0.1, connection: "degraded", observedAt: state.observedAt };
    const result = await new ControlOrchestrator({ reasoner }).decide({
      state,
      context: {
        id: "ctx", query: "quickly", items: [], rendered: "", estimatedTokens: 0, estimatedCostUsd: 0,
        trace: { candidateCount: 0, selectedCount: 0, droppedCount: 0, inputBudget: 100, usedTokens: 0, safetyTokens: 10, durationMs: 0, decisions: [] },
        createdAt: state.observedAt,
      },
    });
    expect(result.directives.find((directive) => directive.type === "turn.setSilence")).toMatchObject({ milliseconds: 1200 });
    expect(result.directives.find((directive) => directive.type === "voice.setPace")).toMatchObject({ rate: 1.5, targetWpm: 260 });
    expect(result.directives).toContainEqual(expect.objectContaining({ type: "model.instruct", text: "Ask one concise follow-up." }));
    expect(result.directives.some((directive) => directive.type === "tool.lookup")).toBe(true);
  });
});

describe("runtime adapters and channels", () => {
  it("uses summary, embedding, state, and external context adapters", async () => {
    const runtime = createLlmovoice({
      stateExtractionMode: "blocking",
      summary: { async summarize() { return "durable dog-friendly hotel memory"; } },
      embedding: { async embed() { return [1, 0, 0]; } },
      stateExtractor: {
        async extract() {
          return { content: { intent: "booking", urgency: 0.4, explicitInstructions: ["under $200"], entities: ["$200"], topics: ["hotel"] } };
        },
      },
      sources: [{
        name: "coachgpt",
        async retrieve() { return [{ id: "profile", source: "coachgpt", content: "The user owns a dog and needs dog-friendly hotels." }]; },
      }],
    });
    const session = runtime.createSession({ userId: "u1", sessionId: "adapter-session" });
    const prepared = await session.ingest({
      type: "user.transcript.completed",
      text: "Find the hotel under $200",
      audio: { uri: "realtime://adapter/input/item", durationMs: 2_000, persisted: false },
      at: new Date().toISOString(),
    });
    expect(prepared?.page.embedding).toEqual([1, 0, 0]);
    expect(prepared?.page.availableFidelities).toContain("audio");
    expect(prepared?.context.items.some((item) => item.unitKind === "external")).toBe(true);
    expect(prepared?.orchestration.state.content.intent).toBe("booking");
  });

  it("supports SMS turns in the same Page/Thread runtime", async () => {
    const session = createLlmovoice().createSession({ userId: "sms-user", sessionId: "sms-session" });
    const turn = await session.prepareSmsTurn("Continue my hotel plan by text message");
    expect(turn.page.input.modality).toBe("sms");
    expect(turn.routing.threads).toHaveLength(1);
    expect(turn.orchestration.state.content.topics).toContain("hotel");
  });

  it("extracts adapter state for written turns before orchestration", async () => {
    const session = createLlmovoice({
      stateExtractionMode: "blocking",
      stateExtractor: {
        async extract() {
          return { content: { intent: "coaching", urgency: 0.3, explicitInstructions: [], entities: [], topics: ["career"] } };
        },
      },
    }).createSession({ userId: "text-user", sessionId: "text-session" });
    const turn = await session.prepareTextTurn("Help me plan a career transition");
    expect(turn.page.state.content.intent).toBe("coaching");
    expect(turn.orchestration.state.content.topics).toContain("career");
  });

  it("keeps model state extraction off the realtime path by default", async () => {
    let release: ((value: { content: { intent: string; urgency: number; explicitInstructions: string[]; entities: string[]; topics: string[] } }) => void) | undefined;
    const session = createLlmovoice({
      stateExtractor: {
        async extract() {
          return new Promise((resolve) => { release = resolve; });
        },
      },
    }).createSession({ userId: "fast-state-user" });
    const started = performance.now();
    const turn = await session.prepareTextTurn("Help me plan a career transition");
    expect(performance.now() - started).toBeLessThan(100);
    expect(turn.page.state.content.intent).toBe("conversation");
    release?.({ content: { intent: "coaching", urgency: 0.3, explicitInstructions: [], entities: [], topics: ["career"] } });
    await session.waitForEnrichment();
    expect((await session.snapshot()).state.content.intent).toBe("coaching");
  });

  it("moves summary enrichment off the realtime completion path", async () => {
    let releaseSummary: ((value: string) => void) | undefined;
    let summaryCalls = 0;
    const runtime = createLlmovoice({
      summary: {
        async summarize() {
          summaryCalls += 1;
          if (summaryCalls > 1) return "refreshed thread summary";
          return new Promise<string>((resolve) => { releaseSummary = resolve; });
        },
      },
      embedding: { async embed() { return [1, 0, 0]; } },
    });
    const session = runtime.createSession({ userId: "background-user", sessionId: "background-session" });
    await session.prepareTextTurn("Remember my quiet hotel preference");
    await session.ingest({ type: "assistant.transcript.completed", text: "I will remember it.", at: new Date().toISOString() });
    expect((await session.snapshot()).pendingEnrichmentTasks).toBe(1);
    expect((await session.snapshot()).pages[0]?.summary).toContain("User:");
    releaseSummary?.("durable background summary");
    await session.waitForEnrichment();
    const snapshot = await session.snapshot();
    expect(snapshot.pendingEnrichmentTasks).toBe(0);
    expect(snapshot.pages[0]?.summary).toBe("durable background summary");
    expect(snapshot.pages[0]?.embedding).toEqual([1, 0, 0]);
  });

  it("bounds slow state and external context adapters", async () => {
    let stateAborted = false;
    let sourceAborted = false;
    const runtime = createLlmovoice({
      stateExtractionMode: "blocking",
      stateExtractionTimeoutMs: 20,
      stateExtractor: { async extract({ signal }) { return new Promise(() => signal?.addEventListener("abort", () => { stateAborted = true; })); } },
      sources: [{ name: "slow", async retrieve({ signal }) { return new Promise(() => signal?.addEventListener("abort", () => { sourceAborted = true; })); } }],
      compiler: { sourceTimeoutMs: 20 },
    });
    const session = runtime.createSession({ userId: "timeout-user", sessionId: "timeout-session" });
    const started = performance.now();
    const turn = await session.prepareTextTurn("Continue without optional workers");
    expect(performance.now() - started).toBeLessThan(250);
    expect(turn.context.items.some((item) => item.unitKind === "external")).toBe(false);
    expect((await session.snapshot()).traces.some((trace) => trace.type === "runtime.fallback")).toBe(true);
    expect(stateAborted).toBe(true);
    expect(sourceAborted).toBe(true);
  });

  it("shares one latency budget across state, embedding, sources, and reasoning", async () => {
    let stateAborted = false;
    let embeddingSawAbort = false;
    let sourceSawAbort = false;
    let reasonerSawAbort = false;
    const runtime = createLlmovoice({
      prepareTurnBudgetMs: 35,
      stateExtractionMode: "blocking",
      stateExtractionTimeoutMs: 1_000,
      stateExtractor: {
        async extract({ signal }) {
          return new Promise(() => signal?.addEventListener("abort", () => { stateAborted = true; }));
        },
      },
      embedding: {
        async embed(_text, options) {
          embeddingSawAbort = Boolean(options?.signal?.aborted);
          return new Promise(() => undefined);
        },
      },
      sources: [{
        name: "slow-after-budget",
        async retrieve({ signal }) {
          sourceSawAbort = Boolean(signal?.aborted);
          return new Promise(() => undefined);
        },
      }],
      orchestrationReasoner: {
        async reason({ signal }) {
          reasonerSawAbort = Boolean(signal?.aborted);
          return new Promise(() => undefined);
        },
      },
      compiler: { sourceTimeoutMs: 1_000 },
    });
    const started = performance.now();
    const turn = await runtime.createSession({ userId: "budget-user" }).prepareTextTurn("Keep the deterministic path responsive");
    expect(performance.now() - started).toBeLessThan(180);
    expect(turn.timing).toMatchObject({ budgetMs: 35, budgetExceeded: true });
    expect(stateAborted).toBe(true);
    expect(embeddingSawAbort).toBe(true);
    expect(sourceSawAbort).toBe(true);
    expect(reasonerSawAbort).toBe(true);
  });

  it("recovers enrichment through a leased durable queue", async () => {
    let job: EnrichmentJob | null = null;
    let completed = false;
    const queue: EnrichmentQueue = {
      async enqueueEnrichment(input) {
        job = { ...input, status: "pending", attempts: 0 };
      },
      async claimEnrichment({ workerId }) {
        if (!job || job.status !== "pending") return null;
        job = { ...job, status: "processing", attempts: job.attempts + 1, workerId };
        return structuredClone(job);
      },
      async completeEnrichment() {
        completed = true;
        if (job) {
          const { workerId: _workerId, ...rest } = job;
          job = { ...rest, status: "completed" };
        }
      },
      async failEnrichment() {
        if (job) {
          const { workerId: _workerId, ...rest } = job;
          job = { ...rest, status: "failed" };
        }
      },
    };
    const runtime = createLlmovoice({
      enrichmentQueue: queue,
      summary: { async summarize() { return "durable queued summary"; } },
      embedding: { async embed() { return [1, 0, 0]; } },
    });
    const session = runtime.createSession({ userId: "queue-user", sessionId: "queue-session" });
    await session.prepareTextTurn("Remember the durable queue");
    await session.ingest({ type: "assistant.transcript.completed", text: "Remembered.", at: new Date().toISOString() });
    await session.waitForEnrichment();
    expect(completed).toBe(true);
    expect((await session.snapshot()).pages[0]?.summary).toBe("durable queued summary");
  });
});
