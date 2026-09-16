import type {
  ContextStore,
  EmbeddingAdapter,
  RuntimeTraceEvent,
  SummaryAdapter,
  VoicePage,
  VoiceThread,
} from "@llmovoice/core";
import {
  clamp,
  compactText,
  cosineSimilarity,
  createId,
  defaultTitle,
  lexicalSimilarity,
  pageText,
  threadText,
  withDeadline,
} from "./utils";

export interface ThreadRoutingConfig {
  appendThreshold: number;
  multiMountMargin: number;
  maxMounts: number;
  recencyHalfLifeMinutes: number;
  spawnPageThreshold: number;
  maxSpawnPages: number;
  embeddingTimeoutMs: number;
  enrichmentTimeoutMs: number;
}

export interface ThreadRoutingResult {
  operation: "append" | "spawn";
  threads: VoiceThread[];
  scores: Array<{ threadId: string; score: number; reasons: string[] }>;
}

const defaultConfig: ThreadRoutingConfig = {
  appendThreshold: 0.32,
  multiMountMargin: 0.08,
  maxMounts: 2,
  recencyHalfLifeMinutes: 45,
  spawnPageThreshold: 0.28,
  maxSpawnPages: 6,
  embeddingTimeoutMs: 250,
  enrichmentTimeoutMs: 8_000,
};

export class ThreadRouter {
  private readonly config: ThreadRoutingConfig;

  constructor(
    private readonly store: ContextStore,
    private readonly embedding?: EmbeddingAdapter,
    private readonly summary?: SummaryAdapter,
    config: Partial<ThreadRoutingConfig> = {},
  ) {
    this.config = { ...defaultConfig, ...config };
  }

  async route(page: VoicePage, options: { signal?: AbortSignal } = {}): Promise<ThreadRoutingResult> {
    const text = pageText(page);
    const recentThreadsPromise = this.store.listThreads(page.userId, { limit: 200, order: "desc" });
    if (!page.embedding && this.embedding) {
      try {
        page.embedding = await withDeadline(
          (signal) => this.embedding!.embed(text, { signal }),
          this.config.embeddingTimeoutMs,
          "embedding-timeout",
          options.signal,
        );
      } catch {
        // Lexical and recency signals remain available as a deterministic fallback.
      }
    }

    const [recentThreads, vectorThreads] = await Promise.all([
      recentThreadsPromise,
      page.embedding && this.store.searchThreads
        ? this.store.searchThreads(page.userId, page.embedding, 40)
        : Promise.resolve([]),
    ]);
    const threads = [...new Map([...vectorThreads, ...recentThreads].map((thread) => [thread.id, thread])).values()]
      .filter((thread) => thread.status !== "archived");
    const explicitThreadIds = Array.isArray(page.metadata.threadIds)
      ? page.metadata.threadIds.filter((id): id is string => typeof id === "string")
      : [];

    const scored = threads
      .map((thread) => {
        const semantic = Math.max(
          lexicalSimilarity(text, threadText(thread)),
          cosineSimilarity(page.embedding, thread.embedding),
        );
        const ageMinutes = Math.max(0, Date.now() - new Date(thread.lastActiveAt).getTime()) / 60_000;
        const recency = Math.pow(0.5, ageMinutes / this.config.recencyHalfLifeMinutes);
        const explicit = explicitThreadIds.includes(thread.id) ? 1 : 0;
        const active = thread.status === "active" ? 1 : 0;
        const score = clamp(explicit * 0.55 + semantic * 0.62 + recency * 0.13 + active * 0.08);
        const reasons = [
          `semantic=${semantic.toFixed(2)}`,
          `recency=${recency.toFixed(2)}`,
          thread.status === "active" ? "active-thread" : "background-thread",
        ];
        if (explicit) reasons.unshift("application-thread-hint");
        return { thread, score, reasons };
      })
      .sort((left, right) => right.score - left.score);

    const bestScore = scored[0]?.score ?? 0;
    const matches = scored
      .filter(({ score }) => score >= this.config.appendThreshold && bestScore - score <= this.config.multiMountMargin)
      .slice(0, this.config.maxMounts);

    if (matches.length === 0) {
      const now = page.updatedAt;
      const [recentPagesDescending, vectorPages] = await Promise.all([
        this.store.listPages(page.userId, { limit: 240, order: "desc" }),
        page.embedding && this.store.searchPages
          ? this.store.searchPages(page.userId, page.embedding, 60)
          : Promise.resolve([]),
      ]);
      const recentPages = recentPagesDescending.reverse();
      const historicalPages = [...new Map([...vectorPages, ...recentPages].map((candidate) => [candidate.id, candidate])).values()]
        .filter((candidate) => candidate.id !== page.id)
        .map((candidate) => ({
          page: candidate,
          score: Math.max(
            lexicalSimilarity(text, pageText(candidate)),
            cosineSimilarity(page.embedding, candidate.embedding),
          ),
        }))
        .filter(({ score }) => score >= this.config.spawnPageThreshold)
        .sort((left, right) => right.score - left.score)
        .slice(0, this.config.maxSpawnPages);
      const linkedPages = [...historicalPages.map(({ page: candidate }) => candidate), page]
        .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
      const summary = compactText(linkedPages.map(pageText).join(" "), 630);
      const threadEmbedding = page.embedding;
      const thread: VoiceThread = {
        id: createId("thread"),
        userId: page.userId,
        title: defaultTitle(page.input.transcript),
        summary,
        ...(threadEmbedding ? { embedding: threadEmbedding } : {}),
        pageIds: linkedPages.map((candidate) => candidate.id),
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
      };
      await this.backgroundOtherThreads(page.userId, []);
      await this.store.saveThread(thread);
      for (const linkedPage of linkedPages) {
        if (!linkedPage.threadIds.includes(thread.id)) linkedPage.threadIds.push(thread.id);
      }
      if (this.store.savePages) await this.store.savePages(linkedPages);
      else await Promise.all(linkedPages.map((linkedPage) => this.store.savePage(linkedPage)));
      await this.trace(page, "thread.spawned", thread.id, {
        score: bestScore,
        recoveredPageIds: historicalPages.map(({ page: candidate }) => candidate.id),
        recoveredScores: historicalPages.map(({ page: candidate, score }) => ({ pageId: candidate.id, score })),
      });
      return {
        operation: "spawn",
        threads: [thread],
        scores: scored.map(({ thread: item, score, reasons }) => ({ threadId: item.id, score, reasons })),
      };
    }

    const mounted: VoiceThread[] = [];
    for (const match of matches) {
      const thread = match.thread;
      if (!thread.pageIds.includes(page.id)) thread.pageIds.push(page.id);
      thread.summary = compactText(`${thread.summary} ${text}`, 770);
      thread.status = "active";
      thread.updatedAt = page.updatedAt;
      thread.lastActiveAt = page.updatedAt;
      mounted.push(thread);
      await this.trace(page, "thread.appended", thread.id, { score: match.score, reasons: match.reasons });
    }
    if (this.store.saveThreads) await this.store.saveThreads(mounted);
    else await Promise.all(mounted.map((thread) => this.store.saveThread(thread)));
    await this.backgroundOtherThreads(page.userId, mounted.map((thread) => thread.id));
    page.threadIds = mounted.map((thread) => thread.id);
    await this.store.savePage(page);
    return {
      operation: "append",
      threads: mounted,
      scores: scored.map(({ thread, score, reasons }) => ({ threadId: thread.id, score, reasons })),
    };
  }

  async refreshPage(page: VoicePage): Promise<void> {
    for (const threadId of page.threadIds) {
      const thread = await this.store.getThread(threadId, page.userId);
      if (!thread) continue;
      const linkedPages = (await Promise.all(thread.pageIds.map((id) => this.store.getPage(id, page.userId))))
        .filter((candidate): candidate is VoicePage => candidate !== null);
      thread.summary = await this.summarize(linkedPages.map(pageText).join(" "), 110);
      const embedding = await this.embed(thread.summary);
      if (embedding) thread.embedding = embedding;
      thread.updatedAt = page.updatedAt;
      await this.store.saveThread(thread);
    }
  }

  async archive(userId: string, threadId: string, sessionId: string): Promise<VoiceThread> {
    const thread = await this.store.getThread(threadId, userId);
    if (!thread || thread.userId !== userId) throw new Error("VoiceThread not found.");
    thread.status = "archived";
    thread.updatedAt = new Date().toISOString();
    await this.store.saveThread(thread);
    await this.store.appendTrace({
      id: createId("trace"),
      type: "thread.archived",
      at: thread.updatedAt,
      userId,
      sessionId,
      threadId,
      data: { title: thread.title },
    });
    return thread;
  }

  private async backgroundOtherThreads(userId: string, activeIds: string[]): Promise<void> {
    const changed: VoiceThread[] = [];
    for (const thread of await this.store.listThreads(userId, { limit: 200, order: "desc" })) {
      if (thread.status === "active" && !activeIds.includes(thread.id)) {
        thread.status = "background";
        changed.push(thread);
      }
    }
    if (changed.length === 0) return;
    if (this.store.saveThreads) await this.store.saveThreads(changed);
    else await Promise.all(changed.map((thread) => this.store.saveThread(thread)));
  }

  private async trace(
    page: VoicePage,
    type: RuntimeTraceEvent["type"],
    threadId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendTrace({
      id: createId("trace"),
      type,
      at: page.updatedAt,
      userId: page.userId,
      sessionId: page.sessionId,
      pageId: page.id,
      threadId,
      data,
    });
  }

  private async summarize(text: string, maxWords: number): Promise<string> {
    if (this.summary) {
      try {
        return compactText(await withDeadline(
          (signal) => this.summary!.summarize(text, maxWords, { signal }),
          this.config.enrichmentTimeoutMs,
          "thread-summary-timeout",
        ), 900);
      } catch {
        // Keep the runtime available when a background model is unavailable.
      }
    }
    return compactText(text, Math.max(320, maxWords * 7));
  }

  private async embed(text: string): Promise<number[] | undefined> {
    if (!this.embedding || !text) return undefined;
    try {
      return await withDeadline(
        (signal) => this.embedding!.embed(text, { signal }),
        this.config.enrichmentTimeoutMs,
        "thread-embedding-timeout",
      );
    } catch {
      return undefined;
    }
  }
}
