import WebSocket, { type RawData } from "ws";
import type { ConversationEvent, Directive, DirectiveExecutor } from "@llmovoice/core";
import type { LlmovoiceSession, PreparedTurn, RuntimeSnapshot } from "@llmovoice/runtime";
import {
  realtimeProviderProfile,
  type MainlandRealtimeProvider,
  type RealtimeProviderConnection,
  type RealtimeProviderProfile,
} from "./profiles";

export type ProviderRealtimeStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error";

export interface ProviderRealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: RawData | string) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface ProviderRealtimeSnapshot {
  provider: MainlandRealtimeProvider;
  status: ProviderRealtimeStatus;
  error: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  rawEventCount: number;
  reconnectAttempts: number;
  queuedEvents: number;
  droppedEvents: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  lastTurnPreparationMs: number | null;
  firstAudioLatencyMs: number | null;
  contextTiming: "before-response" | "next-turn";
  maturity: "stable" | "provider-managed" | "legacy";
  runtime: RuntimeSnapshot | null;
}

export interface ProviderRealtimeToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ProviderRealtimeClientOptions extends RealtimeProviderConnection {
  provider: MainlandRealtimeProvider | RealtimeProviderProfile;
  runtimeSession: LlmovoiceSession;
  directiveExecutors?: DirectiveExecutor[];
  manageProviderConversation?: boolean;
  onAudioDelta?: (base64Audio: string, event: Record<string, unknown>) => void | Promise<void>;
  onToolCall?: (call: ProviderRealtimeToolCall) => unknown | Promise<unknown>;
  onClose?: (snapshot: ProviderRealtimeSnapshot) => void | Promise<void>;
  maxBufferedEvents?: number;
  connectionTimeoutMs?: number;
  reconnect?: false | { maxAttempts?: number; initialDelayMs?: number; maxDelayMs?: number };
  webSocketFactory?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => ProviderRealtimeSocket;
}

type SnapshotListener = (snapshot: ProviderRealtimeSnapshot) => void;
type RawListener = (event: Record<string, unknown>) => void;

function now(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function decodeMessage(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function safeItemId(value: string): string {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : "";
}

export class MainlandRealtimeClient {
  readonly profile: RealtimeProviderProfile;
  private socket: ProviderRealtimeSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private generation = 0;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outboundEvents: string[] = [];
  private readonly listeners = new Set<SnapshotListener>();
  private readonly rawListeners = new Set<RawListener>();
  private eventTail: Promise<void> = Promise.resolve();
  private assistantTranscript = "";
  private assistantAudioActive = false;
  private deletedProviderItems = new Set<string>();
  private responseRequestedAtMs: number | null = null;
  private lastInstructions = "";
  private closeNotified = false;
  private readonly unsubscribeRuntime: () => void;
  private snapshotValue: ProviderRealtimeSnapshot;

  constructor(private readonly options: ProviderRealtimeClientOptions) {
    if (!options.apiKey.trim()) throw new Error("A provider API key is required.");
    this.profile = typeof options.provider === "string"
      ? realtimeProviderProfile(options.provider)
      : options.provider;
    this.snapshotValue = {
      provider: this.profile.id,
      status: "idle",
      error: null,
      connectedAt: null,
      disconnectedAt: null,
      rawEventCount: 0,
      reconnectAttempts: 0,
      queuedEvents: 0,
      droppedEvents: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      lastTurnPreparationMs: null,
      firstAudioLatencyMs: null,
      contextTiming: this.profile.capabilities.contextTiming,
      maturity: this.profile.capabilities.maturity,
      runtime: null,
    };
    this.unsubscribeRuntime = options.runtimeSession.subscribe((runtime) => this.patch({ runtime }));
  }

  get snapshot(): ProviderRealtimeSnapshot {
    return structuredClone(this.snapshotValue);
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  onRawEvent(listener: RawListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.snapshotValue.status === "connected") return;
    if (this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;
    this.closeNotified = false;
    const generation = ++this.generation;
    this.patch({
      status: this.snapshotValue.reconnectAttempts > 0 ? "reconnecting" : "connecting",
      error: null,
    });
    const promise = this.open(generation);
    this.connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
    }
  }

  appendAudio(base64Audio: string): void {
    if (!base64Audio.trim()) return;
    if (!/^[a-zA-Z0-9+/=_-]+$/.test(base64Audio)) throw new Error("Audio must be base64 encoded.");
    this.send(this.profile.audioEvent(base64Audio));
  }

  commitAudio(): void {
    if (!this.profile.commitEvent) {
      throw new Error(`${this.profile.name} uses provider-managed VAD and does not expose manual turn commit.`);
    }
    this.send(this.profile.commitEvent());
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.profile.textEvent) throw new Error(`${this.profile.name} does not expose realtime text input.`);
    const itemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
    this.send(this.profile.textEvent(trimmed, itemId));
    const startedAt = Date.now();
    const prepared = await this.options.runtimeSession.prepareTextTurn(trimmed, { providerItemId: itemId });
    this.patch({ lastTurnPreparationMs: Date.now() - startedAt });
    await this.applyPreparedTurn(prepared);
  }

  cancelResponse(): void {
    this.send(this.profile.cancelEvent());
  }

  async close(reason = "application-ended"): Promise<void> {
    if (this.intentionalClose && (this.snapshotValue.status === "closed" || this.snapshotValue.status === "idle")) return;
    this.intentionalClose = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.patch({ status: "closing" });
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason.slice(0, 120));
    await this.options.runtimeSession.ingest({
      type: "session.disconnected",
      sessionId: this.options.runtimeSession.sessionId,
      at: now(),
      reason,
    }).catch(() => undefined);
    this.patch({ status: "closed", disconnectedAt: now() });
    await this.notifyClose();
  }

  dispose(): void {
    this.unsubscribeRuntime();
    this.listeners.clear();
    this.rawListeners.clear();
    void this.close("disposed");
  }

  private connectionOptions(): RealtimeProviderConnection {
    return {
      apiKey: this.options.apiKey,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.voice ? { voice: this.options.voice } : {}),
      ...(this.options.baseInstructions ? { baseInstructions: this.options.baseInstructions } : {}),
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
      ...(this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {}),
      ...(this.options.headers ? { headers: this.options.headers } : {}),
      ...(this.options.session ? { session: this.options.session } : {}),
    };
  }

  private async open(generation: number): Promise<void> {
    const connection = this.connectionOptions();
    const factory = this.options.webSocketFactory
      ?? ((url, options) => new WebSocket(url, options) as ProviderRealtimeSocket);
    const socket = factory(this.profile.url(connection), { headers: this.profile.headers(connection) });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate?.();
        reject(new Error(`${this.profile.name} connection timed out.`));
      }, Math.max(1_000, this.options.connectionTimeoutMs ?? 10_000));
      let settled = false;
      socket.on("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (error) => {
        if (settled) {
          this.patch({ error: error.message });
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    }).catch((error) => {
      if (generation === this.generation) {
        this.patch({ status: "error", error: error instanceof Error ? error.message : "Realtime connection failed." });
      }
      throw error;
    });
    if (generation !== this.generation || this.intentionalClose) {
      socket.close(1000, "superseded");
      return;
    }
    this.bindSocket(socket, generation);
    this.patch({ status: "connected", connectedAt: this.snapshotValue.connectedAt ?? now(), error: null });
    await this.options.runtimeSession.ingest({
      type: "session.connected",
      sessionId: this.options.runtimeSession.sessionId,
      at: now(),
    });
    this.send(this.profile.sessionEvent(
      connection,
      this.options.baseInstructions ?? "Respond naturally and concisely in the user's language.",
    ));
    this.flush();
  }

  private bindSocket(socket: ProviderRealtimeSocket, generation: number): void {
    socket.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(decodeMessage(data));
        const record = asRecord(parsed);
        if (!record) throw new Error("Expected an object event.");
        event = record;
      } catch {
        this.patch({ error: `Received an invalid ${this.profile.name} event.` });
        return;
      }
      this.eventTail = this.eventTail
        .then(() => this.handleProviderEvent(event))
        .catch((error) => this.patch({ error: error instanceof Error ? error.message : "Realtime event processing failed." }));
    });
    socket.on("close", (code, reason) => {
      if (generation !== this.generation) return;
      this.socket = null;
      if (this.intentionalClose) return;
      const detail = reason.toString("utf8") || `code-${code}`;
      void this.options.runtimeSession.ingest({
        type: "session.disconnected",
        sessionId: this.options.runtimeSession.sessionId,
        at: now(),
        reason: `${this.profile.id}-${detail}`,
      }).catch(() => undefined);
      if (this.options.reconnect === false) {
        this.patch({ status: "error", error: `${this.profile.name} disconnected (${detail}).` });
        void this.notifyClose();
        return;
      }
      this.scheduleReconnect(detail);
    });
  }

  private async handleProviderEvent(event: Record<string, unknown>): Promise<void> {
    const type = readString(event, "type", "event");
    this.patch({ rawEventCount: this.snapshotValue.rawEventCount + 1 });
    for (const listener of this.rawListeners) listener(event);

    const mapped = this.mapProviderEvent(event);
    if (mapped) {
      const startedAt = mapped.type === "user.transcript.completed" ? Date.now() : null;
      const prepared = await this.options.runtimeSession.ingest(mapped);
      if (prepared) {
        if (startedAt !== null) this.patch({ lastTurnPreparationMs: Date.now() - startedAt });
        await this.applyPreparedTurn(prepared);
      }
    }
    if (type === "response.audio_transcript.delta" || type === "response.output_audio_transcript.delta" || type === "response.text.delta") {
      this.assistantTranscript += readString(event, "delta", "text");
    }
    if (type === "response.audio_transcript.done" || type === "response.output_audio_transcript.done" || type === "response.text.done") {
      this.assistantTranscript = "";
    }
    if (type === "response.audio.delta" || type === "response.output_audio.delta") {
      const audio = readString(event, "delta", "audio");
      if (audio) await this.options.onAudioDelta?.(audio, event);
    }
    if (type === "response.function_call_arguments.done") await this.executeToolCall(event);
    if (type === "error") {
      const error = asRecord(event.error);
      this.patch({ error: error ? readString(error, "message", "code") : `${this.profile.name} returned an error.` });
    }
  }

  private mapProviderEvent(event: Record<string, unknown>): ConversationEvent | null {
    const type = readString(event, "type", "event");
    const at = now();
    if (type === "input_audio_buffer.speech_started") return { type: "user.speech.started", at };
    if (type === "input_audio_buffer.speech_stopped") return { type: "user.speech.stopped", at };
    if (type === "conversation.item.input_audio_transcription.delta") {
      return { type: "user.transcript.delta", text: readString(event, "delta", "transcript"), at };
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const providerItemId = safeItemId(readString(event, "item_id"));
      return {
        type: "user.transcript.completed",
        text: readString(event, "transcript", "text"),
        at,
        ...(providerItemId ? { providerItemId } : {}),
      };
    }
    if (
      type === "response.audio_transcript.delta"
      || type === "response.output_audio_transcript.delta"
      || type === "response.text.delta"
    ) {
      return { type: "assistant.transcript.delta", text: readString(event, "delta", "text"), at };
    }
    if (
      type === "response.audio_transcript.done"
      || type === "response.output_audio_transcript.done"
      || type === "response.text.done"
    ) {
      const providerItemId = safeItemId(readString(event, "item_id"));
      return {
        type: "assistant.transcript.completed",
        text: readString(event, "transcript", "text") || this.assistantTranscript,
        at,
        ...(providerItemId ? { providerItemId } : {}),
      };
    }
    if (type === "response.audio.delta" || type === "response.output_audio.delta") {
      if (this.responseRequestedAtMs !== null) {
        this.patch({ firstAudioLatencyMs: Math.max(0, Date.now() - this.responseRequestedAtMs) });
        this.responseRequestedAtMs = null;
      }
      if (!this.assistantAudioActive) {
        this.assistantAudioActive = true;
        return { type: "assistant.audio.started", at };
      }
      return null;
    }
    if (type === "response.audio.done" || type === "response.output_audio.done") {
      this.assistantAudioActive = false;
      return { type: "assistant.audio.stopped", at };
    }
    if (type === "conversation.item.truncated" || type === "response.cancelled") {
      return { type: "response.interrupted", at };
    }
    if (type === "response.done") {
      const response = asRecord(event.response);
      const usage = response ? asRecord(response.usage) : asRecord(event.usage);
      const inputDetails = usage ? asRecord(usage.input_token_details) ?? asRecord(usage.prompt_tokens_details) : null;
      const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
      const cachedInputTokens = Number(inputDetails?.cached_tokens ?? 0);
      this.patch({
        inputTokens: this.snapshotValue.inputTokens + inputTokens,
        outputTokens: this.snapshotValue.outputTokens + outputTokens,
        cachedInputTokens: this.snapshotValue.cachedInputTokens + cachedInputTokens,
      });
      return { type: "response.usage", inputTokens, outputTokens, cachedInputTokens, at };
    }
    return null;
  }

  private async applyPreparedTurn(prepared: PreparedTurn): Promise<void> {
    this.applyDirectives(prepared.orchestration.directives);
    this.reconcileProviderConversation(prepared);
    const modelInstructions = prepared.orchestration.directives
      .filter((directive): directive is Extract<Directive, { type: "model.instruct" }> => directive.type === "model.instruct")
      .map((directive) => directive.text);
    const instructions = [
      this.options.baseInstructions ?? "Respond naturally and concisely in the user's language.",
      prepared.context.rendered,
      ...modelInstructions,
    ].filter(Boolean).join("\n\n");
    this.lastInstructions = instructions;
    for (const event of this.profile.preparedEvents(instructions)) this.send(event);
    if (this.profile.capabilities.contextTiming === "before-response") this.responseRequestedAtMs = Date.now();
  }

  private reconcileProviderConversation(prepared: PreparedTurn): void {
    if (this.options.manageProviderConversation === false || !this.profile.deleteEvent) return;
    const snapshot = this.snapshotValue.runtime;
    if (!snapshot) return;
    const preserve = new Set(
      prepared.context.items
        .filter((item) => item.unitKind === "page" && item.fidelity === "audio")
        .map((item) => item.unitId),
    );
    preserve.add(prepared.page.id);
    for (const page of snapshot.pages) {
      if (preserve.has(page.id)) continue;
      for (const itemId of [page.input.providerItemId, page.output?.providerItemId]) {
        if (!itemId || this.deletedProviderItems.has(itemId)) continue;
        this.send(this.profile.deleteEvent(itemId));
        this.deletedProviderItems.add(itemId);
      }
    }
  }

  private applyDirectives(directives: Directive[]): void {
    for (const directive of directives) {
      if (directive.type === "voice.setPace" && this.profile.paceEvent) {
        this.send(this.profile.paceEvent(Math.max(0.25, Math.min(1.5, directive.rate))));
      }
      if (directive.type === "turn.setSilence" && this.profile.silenceEvent) {
        this.send(this.profile.silenceEvent(directive.milliseconds));
      }
      if (directive.type === "response.pause") this.cancelResponse();
      if (directive.type === "context.archiveThread") {
        void this.options.runtimeSession.archiveThread(directive.threadId).catch(() => undefined);
      }
      if (directive.type.startsWith("app.") || directive.type.startsWith("tool.")) {
        for (const executor of this.options.directiveExecutors ?? []) {
          void Promise.resolve(executor.execute(directive)).then(() => (
            this.options.runtimeSession.recordDirectiveExecution(directive, {
              executor: executor.constructor.name || "DirectiveExecutor",
              status: "succeeded",
            })
          )).catch((error) => (
            this.options.runtimeSession.recordDirectiveExecution(directive, {
              executor: executor.constructor.name || "DirectiveExecutor",
              status: "failed",
              error: error instanceof Error ? error.message : "Directive execution failed.",
            })
          ));
        }
      }
    }
  }

  private async executeToolCall(event: Record<string, unknown>): Promise<void> {
    const callId = readString(event, "call_id");
    const name = readString(event, "name");
    if (!callId || !name) return;
    let args: unknown = {};
    try {
      args = JSON.parse(readString(event, "arguments") || "{}");
    } catch {
      args = { raw: readString(event, "arguments") };
    }
    let output: unknown;
    try {
      if (!this.options.onToolCall) throw new Error(`No server tool handler is registered for ${name}.`);
      output = await this.options.onToolCall({ callId, name, arguments: args });
    } catch (error) {
      output = { error: error instanceof Error ? error.message : "Tool execution failed." };
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output ?? null),
      },
    });
    for (const followup of this.profile.preparedEvents(
      this.lastInstructions || this.options.baseInstructions || "Respond naturally and concisely in the user's language.",
    )) this.send(followup);
  }

  private send(event: Record<string, unknown>): void {
    const serialized = JSON.stringify(event);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (this.intentionalClose || this.snapshotValue.status === "closed" || this.snapshotValue.status === "error") {
      this.patch({ error: `${this.profile.name} event could not be sent because the connection is closed.` });
      return;
    }
    const max = Math.max(1, this.options.maxBufferedEvents ?? 128);
    if (this.outboundEvents.length >= max) {
      this.outboundEvents.shift();
      this.patch({ droppedEvents: this.snapshotValue.droppedEvents + 1 });
    }
    this.outboundEvents.push(serialized);
    this.patch({ queuedEvents: this.outboundEvents.length });
  }

  private flush(): void {
    while (this.socket?.readyState === WebSocket.OPEN && this.outboundEvents.length > 0) {
      this.socket.send(this.outboundEvents.shift()!);
    }
    this.patch({ queuedEvents: this.outboundEvents.length });
  }

  private scheduleReconnect(reason: string): void {
    if (this.intentionalClose || this.options.reconnect === false || this.reconnectTimer) return;
    const config = this.options.reconnect ?? {};
    const maxAttempts = Math.max(0, config.maxAttempts ?? 3);
    if (this.snapshotValue.reconnectAttempts >= maxAttempts) {
      this.patch({ status: "error", error: `${this.profile.name} unavailable after ${maxAttempts} reconnect attempts (${reason}).` });
      void this.notifyClose();
      return;
    }
    const attempt = this.snapshotValue.reconnectAttempts + 1;
    const delay = Math.min(
      Math.max(250, config.maxDelayMs ?? 5_000),
      Math.max(100, config.initialDelayMs ?? 300) * 2 ** (attempt - 1),
    );
    this.patch({ status: "reconnecting", reconnectAttempts: attempt, error: `${this.profile.name} disconnected (${reason}); retrying.` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect("connect-error"));
    }, delay);
  }

  private async notifyClose(): Promise<void> {
    if (this.closeNotified) return;
    this.closeNotified = true;
    await this.options.onClose?.(this.snapshot);
  }

  private patch(patch: Partial<ProviderRealtimeSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createMainlandRealtimeClient(options: ProviderRealtimeClientOptions): MainlandRealtimeClient {
  return new MainlandRealtimeClient(options);
}
