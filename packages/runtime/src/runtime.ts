import type {
  CompiledContext,
  ContextBudget,
  ContextSource,
  ContextStore,
  ConversationEvent,
  EmbeddingAdapter,
  EnrichmentQueue,
  OrchestrationReasoner,
  OrchestrationResult,
  RuntimeTraceEvent,
  StateSnapshot,
  StateExtractionAdapter,
  SummaryAdapter,
  AudioRef,
  VoicePage,
  VoiceThread,
} from "@llmovoice/core";
import { ContextCompiler, type ContextCompilerConfig } from "./context-compiler";
import { ControlOrchestrator } from "./control-orchestrator";
import { MemoryContextStore } from "./memory-store";
import { StateReducer } from "./state-reducer";
import { ThreadRouter, type ThreadRoutingConfig, type ThreadRoutingResult } from "./thread-router";
import { compactText, createId, withDeadline } from "./utils";

export interface LlmovoiceRuntimeConfig {
  store?: ContextStore;
  embedding?: EmbeddingAdapter;
  summary?: SummaryAdapter;
  stateExtractor?: StateExtractionAdapter;
  sources?: ContextSource[];
  orchestrationReasoner?: OrchestrationReasoner;
  orchestrator?: ControlOrchestrator;
  router?: Partial<ThreadRoutingConfig>;
  compiler?: Partial<ContextCompilerConfig>;
  stateExtractionTimeoutMs?: number;
  stateExtractionMode?: "background" | "blocking";
  enrichmentTimeoutMs?: number;
  snapshotLimits?: Partial<{ pages: number; threads: number; traces: number }>;
  enrichmentQueue?: EnrichmentQueue;
  enrichmentLeaseMs?: number;
  enrichmentMaxAttempts?: number;
  prepareTurnBudgetMs?: number;
}

export interface RuntimeSnapshot {
  sessionId: string;
  userId: string;
  pages: VoicePage[];
  threads: VoiceThread[];
  state: StateSnapshot;
  compiledContext: CompiledContext | null;
  orchestration: OrchestrationResult | null;
  traces: RuntimeTraceEvent[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  pendingEnrichmentTasks: number;
}

export interface PreparedTurn {
  page: VoicePage;
  routing: ThreadRoutingResult;
  context: CompiledContext;
  orchestration: OrchestrationResult;
  timing: { totalMs: number; budgetMs: number; budgetExceeded: boolean };
}

export interface SessionResumeOptions {
  threadIds?: string[];
  restoreState?: boolean;
}

type TurnBudgetHandle = {
  startedAtMs: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

function isEnrichmentQueue(value: ContextStore | undefined): value is ContextStore & EnrichmentQueue {
  if (!value) return false;
  const candidate = value as Partial<EnrichmentQueue>;
  return typeof candidate.enqueueEnrichment === "function"
    && typeof candidate.claimEnrichment === "function"
    && typeof candidate.completeEnrichment === "function"
    && typeof candidate.failEnrichment === "function";
}

export class LlmovoiceSession {
  private readonly reducer = new StateReducer();
  private sequence = 0;
  private currentPage: VoicePage | null = null;
  private lastContext: CompiledContext | null = null;
  private lastOrchestration: OrchestrationResult | null = null;
  private readonly usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  private readonly listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private enrichmentTail: Promise<void> = Promise.resolve();
  private restored = false;
  private restorePromise: Promise<void> | null = null;
  private nextThreadHints: string[] = [];

  constructor(
    readonly sessionId: string,
    readonly userId: string,
    private readonly store: ContextStore,
    private readonly router: ThreadRouter,
    private readonly compiler: ContextCompiler,
    private readonly orchestrator: ControlOrchestrator,
    private readonly embedding?: EmbeddingAdapter,
    private readonly summary?: SummaryAdapter,
    private readonly stateExtractor?: StateExtractionAdapter,
    private readonly stateExtractionTimeoutMs = 700,
    private readonly stateExtractionMode: "background" | "blocking" = "background",
    private readonly enrichmentTimeoutMs = 8_000,
    private readonly snapshotLimits = { pages: 500, threads: 200, traces: 1_000 },
    private readonly enrichmentQueue?: EnrichmentQueue,
    private readonly enrichmentLeaseMs = 30_000,
    private readonly enrichmentMaxAttempts = 5,
    private readonly resumeOptions: false | SessionResumeOptions = false,
    private readonly prepareTurnBudgetMs = 250,
  ) {}

  subscribe(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    void this.snapshot().then(listener);
    return () => this.listeners.delete(listener);
  }

  async ingest(event: ConversationEvent): Promise<PreparedTurn | null> {
    this.reducer.update(event);
    if (event.type === "response.usage") {
      this.usage.inputTokens += event.inputTokens;
      this.usage.outputTokens += event.outputTokens;
      this.usage.cachedInputTokens += event.cachedInputTokens ?? 0;
      await this.trace("usage.updated", { ...this.usage });
    }

    if (event.type === "user.transcript.completed") {
      await this.ensureRestored();
      const budget = this.startTurnBudget();
      if (this.stateExtractor) {
        if (this.stateExtractionMode === "blocking") await this.runStateExtraction(event.text, event.at, event.audio, "audio", budget.controller.signal);
        else this.scheduleStateExtraction(event.text, event.at, event.audio);
      }
      const prepared = await this.prepareTurn(event.text, event.at, "audio", event.audio, event.providerItemId, budget);
      await this.emit();
      return prepared;
    }

    if (event.type === "assistant.transcript.completed" && this.currentPage) {
      this.currentPage.output = {
        modality: this.currentPage.input.modality,
        transcript: event.text.trim(),
        ...(event.audio ? { audio: event.audio } : {}),
        ...(event.providerItemId ? { providerItemId: event.providerItemId } : {}),
        completedAt: event.at,
      };
      const fullTurn = `User: ${this.currentPage.input.transcript} Assistant: ${event.text}`;
      this.currentPage.summary = compactText(fullTurn, 560);
      if (event.audio && !this.currentPage.availableFidelities.includes("audio")) {
        this.currentPage.availableFidelities.unshift("audio");
      }
      this.currentPage.status = "complete";
      this.currentPage.updatedAt = event.at;
      await this.store.savePage(this.currentPage);
      await this.trace("page.completed", { outputCharacters: event.text.length }, this.currentPage.id);
      const completedPageId = this.currentPage.id;
      this.currentPage = null;
      await this.scheduleEnrichment(completedPageId);
    }

    if (event.type === "response.interrupted" && this.currentPage) {
      this.currentPage.status = "interrupted";
      this.currentPage.updatedAt = event.at;
      await this.store.savePage(this.currentPage);
    }

    if (event.type === "environment.updated" || event.type.startsWith("session.")) {
      await this.trace("state.changed", { state: this.reducer.snapshot });
      if (event.type === "environment.updated" && event.source && event.source !== "application") {
        await this.trace("telemetry.sampled", { source: event.source, environment: event.environment });
      }
    }

    if (
      event.type === "user.speech.started"
      || event.type === "user.speech.stopped"
      || event.type === "user.transcript.delta"
      || event.type === "assistant.transcript.delta"
      || event.type === "assistant.audio.started"
      || event.type === "assistant.audio.stopped"
    ) return null;

    await this.emit();
    return null;
  }

  async prepareTextTurn(text: string, options: { providerItemId?: string } = {}): Promise<PreparedTurn> {
    await this.ensureRestored();
    const budget = this.startTurnBudget();
    const at = new Date().toISOString();
    await this.prepareWrittenState(text, at, budget.controller.signal);
    const prepared = await this.prepareTurn(text, at, "text", undefined, options.providerItemId, budget);
    await this.emit();
    return prepared;
  }

  async prepareSmsTurn(text: string, options: { providerItemId?: string } = {}): Promise<PreparedTurn> {
    await this.ensureRestored();
    const budget = this.startTurnBudget();
    const at = new Date().toISOString();
    await this.prepareWrittenState(text, at, budget.controller.signal);
    const prepared = await this.prepareTurn(text, at, "sms", undefined, options.providerItemId, budget);
    await this.emit();
    return prepared;
  }

  async archiveThread(threadId: string): Promise<VoiceThread> {
    const thread = await this.router.archive(this.userId, threadId, this.sessionId);
    await this.emit();
    return thread;
  }

  async restore(options: SessionResumeOptions = {}): Promise<void> {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.restoreFromStore(options)
      .then(() => { this.restored = true; })
      .catch((error) => {
        this.restorePromise = null;
        throw error;
      });
    return this.restorePromise;
  }

  async resumeThread(threadId: string): Promise<VoiceThread> {
    const thread = await this.store.getThread(threadId, this.userId);
    if (!thread || thread.status === "archived") throw new Error("Cannot resume an unavailable Thread.");
    this.nextThreadHints = [thread.id];
    await this.trace("session.restored", { threadIds: [thread.id], source: "application" });
    return thread;
  }

  async updateContent(input: Partial<StateSnapshot["content"]>): Promise<void> {
    this.reducer.updateContent(input);
    await this.trace("state.changed", { state: this.reducer.snapshot, source: "application" });
    await this.emit();
  }

  async updateStyle(input: Partial<StateSnapshot["style"]>): Promise<void> {
    this.reducer.updateStyle(input);
    await this.trace("state.changed", { state: this.reducer.snapshot, source: "application" });
    await this.emit();
  }

  async recordDirectiveExecution(
    directive: OrchestrationResult["directives"][number],
    input: { executor: string; status: "succeeded" | "failed"; error?: string },
  ): Promise<void> {
    await this.trace("directive.executed", { directive, ...input });
    await this.emit();
  }

  async waitForEnrichment(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  async resumeEnrichment(): Promise<void> {
    if (!this.enrichmentQueue) return;
    const run = this.drainEnrichmentQueue();
    this.backgroundTasks.add(run);
    try {
      await run;
    } finally {
      this.backgroundTasks.delete(run);
      await this.emit();
    }
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    await this.ensureRestored();
    const [pages, threads, traces] = await Promise.all([
      this.store.listPages(this.userId, { limit: this.snapshotLimits.pages, order: "asc" }),
      this.store.listThreads(this.userId, { limit: this.snapshotLimits.threads, order: "desc" }),
      this.store.listTraces(this.sessionId, this.userId, { limit: this.snapshotLimits.traces, order: "asc" }),
    ]);
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      pages,
      threads,
      state: this.reducer.snapshot,
      compiledContext: this.lastContext ? structuredClone(this.lastContext) : null,
      orchestration: this.lastOrchestration ? structuredClone(this.lastOrchestration) : null,
      traces,
      usage: { ...this.usage },
      pendingEnrichmentTasks: this.backgroundTasks.size,
    };
  }

  private async prepareTurn(
    text: string,
    at: string,
    modality: "audio" | "text" | "sms" = "audio",
    audio?: AudioRef,
    providerItemId?: string,
    budget = this.startTurnBudget(),
  ): Promise<PreparedTurn> {
    const transcript = text.trim();
    this.sequence += 1;
    const summary = compactText(transcript, 320);
    const page: VoicePage = {
      id: createId("page"),
      userId: this.userId,
      sessionId: this.sessionId,
      sequence: this.sequence,
      status: "open",
      input: {
        modality,
        transcript,
        ...(audio ? { audio } : {}),
        ...(providerItemId ? { providerItemId } : {}),
        completedAt: at,
      },
      summary,
      state: this.reducer.snapshot,
      availableFidelities: [...(audio ? (["audio"] as const) : []), "transcript", "summary", "drop"],
      threadIds: [],
      metadata: this.nextThreadHints.length > 0 ? { threadIds: [...this.nextThreadHints] } : {},
      createdAt: at,
      updatedAt: at,
    };
    await this.store.savePage(page);
    this.currentPage = page;
    await this.trace("page.created", { sequence: page.sequence, modality }, page.id);

    const routing = await this.router.route(page, { signal: budget.controller.signal });
    this.nextThreadHints = [];
    const activeThreadIds = routing.threads.map((thread) => thread.id);
    const context = await this.compiler.compile({
      userId: this.userId,
      query: transcript,
      currentPage: page,
      activeThreadIds,
      state: this.reducer.snapshot,
      signal: budget.controller.signal,
    });
    const orchestration = await this.orchestrator.decide({
      state: this.reducer.snapshot,
      context,
      activeThreadIds,
      signal: budget.controller.signal,
    });
    clearTimeout(budget.timer);
    const totalMs = Number((performance.now() - budget.startedAtMs).toFixed(2));
    const timing = {
      totalMs,
      budgetMs: this.prepareTurnBudgetMs,
      budgetExceeded: budget.controller.signal.aborted || totalMs > this.prepareTurnBudgetMs,
    };
    this.lastContext = context;
    this.lastOrchestration = orchestration;
    const traceEvents: RuntimeTraceEvent[] = [this.traceEvent("context.compiled", {
      contextId: context.id,
      estimatedTokens: context.estimatedTokens,
      estimatedCostUsd: context.estimatedCostUsd,
      trace: context.trace,
      timing,
    }, page.id)];
    for (const directive of orchestration.directives) {
      traceEvents.push(this.traceEvent("directive.emitted", { directive }, page.id));
    }
    if (this.store.appendTraces) await this.store.appendTraces(traceEvents);
    else await Promise.all(traceEvents.map((event) => this.store.appendTrace(event)));
    return { page, routing, context, orchestration, timing };
  }

  private async ensureRestored(): Promise<void> {
    if (this.restored || this.resumeOptions === false) return;
    await this.restore(this.resumeOptions);
  }

  private async restoreFromStore(options: SessionResumeOptions): Promise<void> {
    const [pages, threads] = await Promise.all([
      this.store.listPages(this.userId, { limit: this.snapshotLimits.pages, order: "desc", sessionId: this.sessionId }),
      this.store.listThreads(this.userId, { limit: this.snapshotLimits.threads, order: "desc" }),
    ]);
    const sessionPages = pages;
    this.sequence = sessionPages.reduce((highest, page) => Math.max(highest, page.sequence), 0);
    const latestPage = sessionPages.sort((left, right) => right.sequence - left.sequence)[0];
    if (latestPage && options.restoreState !== false) this.reducer.restore(latestPage.state);

    const requested = new Set((options.threadIds ?? []).filter(Boolean));
    const resumable = threads.filter((thread) => thread.status !== "archived");
    this.nextThreadHints = requested.size > 0
      ? resumable.filter((thread) => requested.has(thread.id)).map((thread) => thread.id)
      : resumable.filter((thread) => thread.status === "active").slice(0, 2).map((thread) => thread.id);
    await this.trace("session.restored", {
      restoredPages: sessionPages.length,
      sequence: this.sequence,
      threadIds: this.nextThreadHints,
      stateRestored: Boolean(latestPage && options.restoreState !== false),
    });
  }

  private startTurnBudget(): TurnBudgetHandle {
    const controller = new AbortController();
    return {
      startedAtMs: performance.now(),
      controller,
      timer: setTimeout(
        () => controller.abort(new Error("prepare-turn-latency-budget-exceeded")),
        this.prepareTurnBudgetMs,
      ),
    };
  }

  private async prepareWrittenState(text: string, at: string, signal?: AbortSignal): Promise<void> {
    const event: ConversationEvent = { type: "user.transcript.completed", text, at };
    this.reducer.update(event);
    if (!this.stateExtractor) return;
    if (this.stateExtractionMode === "blocking") await this.runStateExtraction(text, at, undefined, "written", signal);
    else this.scheduleStateExtraction(text, at, undefined, "written");
  }

  private async trace(type: RuntimeTraceEvent["type"], data: Record<string, unknown>, pageId?: string): Promise<void> {
    await this.store.appendTrace(this.traceEvent(type, data, pageId));
  }

  private traceEvent(type: RuntimeTraceEvent["type"], data: Record<string, unknown>, pageId?: string): RuntimeTraceEvent {
    return {
      id: createId("trace"),
      type,
      at: new Date().toISOString(),
      userId: this.userId,
      sessionId: this.sessionId,
      ...(pageId ? { pageId } : {}),
      data,
    };
  }

  private async emit(): Promise<void> {
    if (this.listeners.size === 0) return;
    const snapshot = await this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async summarize(text: string, maxWords: number, maxCharacters: number): Promise<string> {
    if (this.summary) {
      try {
        return compactText(await withDeadline(
          (signal) => this.summary!.summarize(text, maxWords, { signal }),
          this.enrichmentTimeoutMs,
          "summary-timeout",
        ), maxCharacters);
      } catch {
        await this.trace("runtime.fallback", { component: "summary" });
      }
    }
    return compactText(text, maxCharacters);
  }

  private async extractState(text: string, audio?: AudioRef, parentSignal?: AbortSignal) {
    if (!this.stateExtractor) return {};
    return withDeadline(
      (signal) => this.stateExtractor!.extract({ text, current: this.reducer.snapshot, ...(audio ? { audio } : {}), signal }),
      this.stateExtractionTimeoutMs,
      "state-extraction-timeout",
      parentSignal,
    );
  }

  private async runStateExtraction(text: string, at: string, audio?: AudioRef, channel: "audio" | "written" = "audio", signal?: AbortSignal): Promise<void> {
    try {
      const extracted = await this.extractState(text, audio, signal);
      this.reducer.mergeExtraction(extracted, at);
      await this.trace("state.extracted", { source: "adapter", channel, extracted });
    } catch {
      await this.trace("runtime.fallback", { component: "state-extractor", channel });
    }
  }

  private scheduleStateExtraction(text: string, at: string, audio?: AudioRef, channel: "audio" | "written" = "audio"): void {
    const run = this.runStateExtraction(text, at, audio, channel);
    this.backgroundTasks.add(run);
    void run
      .finally(async () => {
        this.backgroundTasks.delete(run);
        await this.emit();
      })
      .catch(() => undefined);
  }

  private async scheduleEnrichment(pageId: string): Promise<void> {
    if (this.enrichmentQueue) {
      const at = new Date().toISOString();
      await this.enrichmentQueue.enqueueEnrichment({
        id: `enrichment_${pageId}`,
        userId: this.userId,
        pageId,
        maxAttempts: this.enrichmentMaxAttempts,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
      });
      void this.resumeEnrichment().catch((error) => this.trace("runtime.fallback", {
        component: "durable-enrichment-worker",
        error: error instanceof Error ? error.message : "unknown",
      }, pageId));
      return;
    }
    const run = this.enrichmentTail.then(() => this.enrichPage(pageId));
    this.enrichmentTail = run.catch(() => undefined);
    this.backgroundTasks.add(run);
    void run
      .catch(async (error) => {
        await this.trace("runtime.fallback", {
          component: "background-enrichment",
          error: error instanceof Error ? error.message : "unknown",
        }, pageId);
      })
      .finally(async () => {
        this.backgroundTasks.delete(run);
        await this.emit();
      });
  }

  private async drainEnrichmentQueue(): Promise<void> {
    if (!this.enrichmentQueue) return;
    const workerId = createId("worker");
    for (;;) {
      const job = await this.enrichmentQueue.claimEnrichment({
        userId: this.userId,
        workerId,
        leaseMs: this.enrichmentLeaseMs,
      });
      if (!job) return;
      try {
        await this.enrichPage(job.pageId);
        await this.enrichmentQueue.completeEnrichment({
          id: job.id,
          userId: this.userId,
          workerId,
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        const retryDelay = Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
        await this.enrichmentQueue.failEnrichment({
          id: job.id,
          userId: this.userId,
          workerId,
          error: error instanceof Error ? error.message : "unknown",
          retryAt: new Date(Date.now() + retryDelay).toISOString(),
        });
      }
    }
  }

  private async enrichPage(pageId: string): Promise<void> {
    const page = await this.store.getPage(pageId, this.userId);
    if (!page || page.status !== "complete") return;
    const fullTurn = `User: ${page.input.transcript} Assistant: ${page.output?.transcript ?? ""}`;
    page.summary = await this.summarize(fullTurn, 80, 560);
    const embedding = await this.embed(page.summary);
    if (embedding) page.embedding = embedding;
    page.updatedAt = new Date().toISOString();
    await this.store.savePage(page);
    await this.router.refreshPage(page);
  }

  private async embed(text: string): Promise<number[] | undefined> {
    if (!this.embedding || !text) return undefined;
    try {
      return await withDeadline(
        (signal) => this.embedding!.embed(text, { signal }),
        this.enrichmentTimeoutMs,
        "embedding-enrichment-timeout",
      );
    } catch {
      await this.trace("runtime.fallback", { component: "embedding" });
      return undefined;
    }
  }
}

export class LlmovoiceRuntime {
  readonly store: ContextStore;
  readonly router: ThreadRouter;
  readonly compiler: ContextCompiler;
  readonly orchestrator: ControlOrchestrator;
  private readonly embedding: EmbeddingAdapter | undefined;
  private readonly summary: SummaryAdapter | undefined;
  private readonly stateExtractor: StateExtractionAdapter | undefined;
  private readonly stateExtractionTimeoutMs: number;
  private readonly stateExtractionMode: "background" | "blocking";
  private readonly enrichmentTimeoutMs: number;
  private readonly snapshotLimits: { pages: number; threads: number; traces: number };
  private readonly enrichmentQueue: EnrichmentQueue | undefined;
  private readonly enrichmentLeaseMs: number;
  private readonly enrichmentMaxAttempts: number;
  private readonly prepareTurnBudgetMs: number;

  constructor(config: LlmovoiceRuntimeConfig = {}) {
    this.store = config.store ?? new MemoryContextStore();
    this.embedding = config.embedding;
    this.summary = config.summary;
    this.stateExtractor = config.stateExtractor;
    this.stateExtractionTimeoutMs = Math.max(50, config.stateExtractionTimeoutMs ?? 700);
    this.stateExtractionMode = config.stateExtractionMode ?? "background";
    this.enrichmentTimeoutMs = Math.max(100, config.enrichmentTimeoutMs ?? 8_000);
    this.snapshotLimits = {
      pages: Math.max(1, config.snapshotLimits?.pages ?? 500),
      threads: Math.max(1, config.snapshotLimits?.threads ?? 200),
      traces: Math.max(1, config.snapshotLimits?.traces ?? 1_000),
    };
    this.enrichmentQueue = config.enrichmentQueue ?? (isEnrichmentQueue(config.store) ? config.store : undefined);
    this.enrichmentLeaseMs = Math.max(5_000, config.enrichmentLeaseMs ?? 30_000);
    this.enrichmentMaxAttempts = Math.max(1, Math.min(20, config.enrichmentMaxAttempts ?? 5));
    this.prepareTurnBudgetMs = Math.max(25, config.prepareTurnBudgetMs ?? 250);
    this.router = new ThreadRouter(this.store, config.embedding, config.summary, config.router);
    const defaults: ContextCompilerConfig = {
      budget: {
        maxInputTokens: 10_000,
        reservedOutputTokens: 1_500,
      },
      costModel: {
        audioTokensPerSecond: 10,
        textTokensPerWord: 1.33,
      },
      maxCandidates: 80,
      minRelevance: 0.04,
      sourceTimeoutMs: 350,
    };
    this.compiler = new ContextCompiler(this.store, config.sources ?? [], {
      ...defaults,
      ...config.compiler,
      budget: { ...defaults.budget, ...config.compiler?.budget },
      costModel: { ...defaults.costModel, ...config.compiler?.costModel },
    });
    this.orchestrator = config.orchestrator ?? new ControlOrchestrator({
      ...(config.orchestrationReasoner ? { reasoner: config.orchestrationReasoner } : {}),
    });
  }

  createSession(input: { userId: string; sessionId?: string; resume?: boolean | SessionResumeOptions }): LlmovoiceSession {
    const session = new LlmovoiceSession(
      input.sessionId ?? createId("session"),
      input.userId,
      this.store,
      this.router,
      this.compiler,
      this.orchestrator,
      this.embedding,
      this.summary,
      this.stateExtractor,
      this.stateExtractionTimeoutMs,
      this.stateExtractionMode,
      this.enrichmentTimeoutMs,
      this.snapshotLimits,
      this.enrichmentQueue,
      this.enrichmentLeaseMs,
      this.enrichmentMaxAttempts,
      input.resume === true ? {} : input.resume ?? false,
      this.prepareTurnBudgetMs,
    );
    if (this.enrichmentQueue) void session.resumeEnrichment().catch(() => undefined);
    return session;
  }
}

export function createLlmovoice(config: LlmovoiceRuntimeConfig = {}): LlmovoiceRuntime {
  return new LlmovoiceRuntime(config);
}

export type { ContextBudget };
