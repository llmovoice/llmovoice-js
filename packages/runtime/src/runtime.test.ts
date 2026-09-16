import { describe, expect, it } from "vitest";
import type { StateSnapshot, VoicePage } from "@llmovoice/core";
import { ContextCompiler } from "./context-compiler";
import { ControlOrchestrator } from "./control-orchestrator";
import { MemoryContextStore } from "./memory-store";
import { createInitialState } from "./state-reducer";
import { ThreadRouter } from "./thread-router";
import { createLlmovoice } from "./runtime";

function page(input: {
  id: string;
  sequence: number;
  transcript: string;
  state?: StateSnapshot;
  threadIds?: string[];
}): VoicePage {
  const at = new Date(Date.now() + input.sequence * 1_000).toISOString();
  return {
    id: input.id,
    userId: "user-1",
    sessionId: "session-1",
    sequence: input.sequence,
    status: "complete",
    input: { modality: "text", transcript: input.transcript, completedAt: at },
    output: { modality: "text", transcript: "Acknowledged.", completedAt: at },
    summary: input.transcript,
    state: input.state ?? createInitialState(at),
    availableFidelities: ["transcript", "summary", "drop"],
    threadIds: input.threadIds ?? [],
    metadata: {},
    createdAt: at,
    updatedAt: at,
  };
}

describe("ThreadRouter", () => {
  it("spawns, appends, and returns to a prior topic", async () => {
    const store = new MemoryContextStore();
    const router = new ThreadRouter(store);

    const first = page({ id: "p1", sequence: 1, transcript: "vancouver hotel dog budget vancouver hotel" });
    const firstResult = await router.route(first);
    expect(firstResult.operation).toBe("spawn");

    const second = page({ id: "p2", sequence: 2, transcript: "client meeting launch delivery risk client meeting" });
    const secondResult = await router.route(second);
    expect(secondResult.operation).toBe("spawn");

    const third = page({ id: "p3", sequence: 3, transcript: "vancouver hotel dog budget near park" });
    const thirdResult = await router.route(third);
    expect(thirdResult.operation).toBe("append");
    expect(thirdResult.threads[0]?.pageIds).toEqual(["p1", "p3"]);
    expect((await store.listThreads("user-1"))).toHaveLength(2);
  });
});

describe("ContextCompiler", () => {
  it("never exceeds its input budget and emits a decision trace", async () => {
    const store = new MemoryContextStore();
    for (let index = 0; index < 20; index += 1) {
      await store.savePage(page({
        id: `page-${index}`,
        sequence: index,
        transcript: `hotel budget dog park constraint ${index} ${"detail ".repeat(24)}`,
      }));
    }
    const compiler = new ContextCompiler(store, [], {
      budget: { maxInputTokens: 150, reservedOutputTokens: 50 },
      costModel: { audioTokensPerSecond: 10, textTokensPerWord: 1.33 },
      maxCandidates: 40,
      minRelevance: 0,
    });
    const result = await compiler.compile({
      userId: "user-1",
      query: "hotel dog budget",
      state: createInitialState(),
    });
    expect(result.estimatedTokens).toBeLessThanOrEqual(100);
    expect(result.trace.inputBudget).toBe(100);
    expect(result.trace.decisions.length).toBeLessThan(20);
    expect(result.trace.decisions.length).toBeGreaterThan(0);
    expect(result.trace.droppedCount).toBeGreaterThan(0);
  });
});

describe("ControlOrchestrator", () => {
  it("prioritizes network safety over response speed", async () => {
    const state = createInitialState();
    state.environment = {
      latencyMs: 680,
      jitterMs: 260,
      packetLoss: 0.1,
      connection: "degraded",
      observedAt: new Date().toISOString(),
    };
    state.style.userWpm = 190;
    const result = await new ControlOrchestrator().decide({
      state,
      context: {
        id: "context-1",
        query: "answer quickly",
        items: [],
        rendered: "",
        estimatedTokens: 0,
        estimatedCostUsd: 0,
        trace: {
          candidateCount: 0,
          selectedCount: 0,
          droppedCount: 0,
          inputBudget: 100,
          usedTokens: 0,
          safetyTokens: 20,
          durationMs: 0,
          decisions: [],
        },
        createdAt: new Date().toISOString(),
      },
    });
    const silence = result.directives.find((directive) => directive.type === "turn.setSilence");
    expect(silence).toMatchObject({ type: "turn.setSilence", milliseconds: 1200 });
  });
});

describe("LlmovoiceRuntime", () => {
  it("materializes completed turns and compiles thread-local history", async () => {
    const runtime = createLlmovoice({
      compiler: { budget: { maxInputTokens: 400, reservedOutputTokens: 100 } },
    });
    const session = runtime.createSession({ userId: "user-1", sessionId: "session-1" });

    await session.prepareTextTurn("vancouver hotel under 200 dollars dog friendly");
    await session.ingest({ type: "assistant.transcript.completed", text: "I will remember those constraints.", at: new Date().toISOString() });
    await session.prepareTextTurn("client meeting launch risk timeline");
    await session.ingest({ type: "assistant.transcript.completed", text: "Let's prepare the meeting.", at: new Date().toISOString() });
    const returned = await session.prepareTextTurn("vancouver hotel dog budget near park");

    expect(returned.routing.operation).toBe("append");
    expect(returned.context.rendered).toContain("dog friendly");
    const snapshot = await session.snapshot();
    expect(snapshot.pages).toHaveLength(3);
    expect(snapshot.threads).toHaveLength(2);
    expect(snapshot.traces.some((trace) => trace.type === "context.compiled")).toBe(true);
  });

  it("restores sequence, state, and the active Thread after re-entry", async () => {
    const store = new MemoryContextStore();
    const runtime = createLlmovoice({ store });
    const first = runtime.createSession({ userId: "user-1", sessionId: "recoverable" });
    const initial = await first.prepareTextTurn("My goal is a dog-friendly Vancouver hotel under $200");
    await first.ingest({ type: "assistant.transcript.completed", text: "I will remember it.", at: new Date().toISOString() });

    const restored = runtime.createSession({ userId: "user-1", sessionId: "recoverable", resume: true });
    const snapshot = await restored.snapshot();
    expect(snapshot.state.content.entities).toContain("$200");
    const next = await restored.prepareTextTurn("Continue with somewhere near a park");

    expect(next.page.sequence).toBe(2);
    expect(next.routing.operation).toBe("append");
    expect(next.routing.threads[0]?.id).toBe(initial.routing.threads[0]?.id);
    expect((await restored.snapshot()).traces.some((trace) => trace.type === "session.restored")).toBe(true);
  });
});
