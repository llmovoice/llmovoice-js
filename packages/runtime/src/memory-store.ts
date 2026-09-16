import type { ContextStore, RuntimeTraceEvent, StoreListOptions, VoicePage, VoiceThread } from "@llmovoice/core";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryContextStore implements ContextStore {
  private readonly pages = new Map<string, VoicePage>();
  private readonly threads = new Map<string, VoiceThread>();
  private readonly traces = new Map<string, RuntimeTraceEvent[]>();

  async savePage(page: VoicePage): Promise<void> {
    this.pages.set(page.id, copy(page));
  }

  async savePages(pages: VoicePage[]): Promise<void> {
    for (const page of pages) this.pages.set(page.id, copy(page));
  }

  async getPage(id: string, userId?: string): Promise<VoicePage | null> {
    const page = this.pages.get(id);
    return page && (!userId || page.userId === userId) ? copy(page) : null;
  }

  async listPages(userId: string, options: StoreListOptions = {}): Promise<VoicePage[]> {
    const pages = Array.from(this.pages.values())
      .filter((page) => page.userId === userId && (!options.sessionId || page.sessionId === options.sessionId))
      .sort((left, right) => {
        const comparison = options.sessionId
          ? left.sequence - right.sequence
          : left.createdAt.localeCompare(right.createdAt);
        return options.order === "desc" ? -comparison : comparison;
      });
    return pages.slice(0, options.limit ?? pages.length).map(copy);
  }

  async saveThread(thread: VoiceThread): Promise<void> {
    this.threads.set(thread.id, copy(thread));
  }

  async saveThreads(threads: VoiceThread[]): Promise<void> {
    for (const thread of threads) this.threads.set(thread.id, copy(thread));
  }

  async getThread(id: string, userId?: string): Promise<VoiceThread | null> {
    const thread = this.threads.get(id);
    return thread && (!userId || thread.userId === userId) ? copy(thread) : null;
  }

  async listThreads(userId: string, options: StoreListOptions = {}): Promise<VoiceThread[]> {
    const threads = Array.from(this.threads.values())
      .filter((thread) => thread.userId === userId)
      .sort((left, right) => options.order === "asc"
        ? left.lastActiveAt.localeCompare(right.lastActiveAt)
        : right.lastActiveAt.localeCompare(left.lastActiveAt));
    return threads.slice(0, options.limit ?? threads.length).map(copy);
  }

  async appendTrace(event: RuntimeTraceEvent): Promise<void> {
    const existing = this.traces.get(event.sessionId) ?? [];
    existing.push(copy(event));
    this.traces.set(event.sessionId, existing);
  }

  async appendTraces(events: RuntimeTraceEvent[]): Promise<void> {
    for (const event of events) await this.appendTrace(event);
  }

  async listTraces(sessionId: string, userId?: string, options: StoreListOptions = {}): Promise<RuntimeTraceEvent[]> {
    const traces = (this.traces.get(sessionId) ?? [])
      .filter((trace) => !userId || trace.userId === userId)
      .sort((left, right) => options.order === "desc" ? right.at.localeCompare(left.at) : left.at.localeCompare(right.at));
    return traces.slice(0, options.limit ?? traces.length).map(copy);
  }

  clear(): void {
    this.pages.clear();
    this.threads.clear();
    this.traces.clear();
  }
}
