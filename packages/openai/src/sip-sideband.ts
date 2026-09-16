import WebSocket, { type RawData } from "ws";
import type {
  AudioRef,
  ConversationEvent,
  Directive,
  DirectiveExecutor,
} from "@llmovoice/core";
import type {
  LlmovoiceSession,
  PreparedTurn,
  RuntimeSnapshot,
} from "@llmovoice/runtime";

export type OpenAISipSidebandStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error";

export interface OpenAISipToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface OpenAISipSidebandSnapshot {
  callId: string;
  status: OpenAISipSidebandStatus;
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
  runtime: RuntimeSnapshot | null;
}

export interface OpenAISipSidebandSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: RawData | string) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface OpenAISipSidebandOptions {
  apiKey: string;
  callId: string;
  runtimeSession: LlmovoiceSession;
  baseInstructions?: string;
  initialResponseInstructions?: string;
  safetyIdentifier?: string;
  directiveExecutors?: DirectiveExecutor[];
  onToolCall?: (call: OpenAISipToolCall) => unknown | Promise<unknown>;
  onLimit?: (reason: "duration" | "tokens") => void | Promise<void>;
  onClose?: (snapshot: OpenAISipSidebandSnapshot) => void | Promise<void>;
  manageProviderConversation?: boolean;
  maxDurationMs?: number;
  maxTotalTokens?: number;
  maxBufferedEvents?: number;
  connectionTimeoutMs?: number;
  reconnect?: false | {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  webSocketFactory?: (
    url: string,
    options: { headers: Record<string, string> },
  ) => OpenAISipSidebandSocket;
  url?: string;
}

type SnapshotListener = (snapshot: OpenAISipSidebandSnapshot) => void;
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

function safeCallId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{8,160}$/.test(value)) {
    throw new Error("Invalid Realtime call ID.");
  }
  return value;
}

function decodeMessage(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export class OpenAISipSidebandClient {
  private socket: OpenAISipSidebandSocket | null = null;
  private readonly listeners = new Set<SnapshotListener>();
  private readonly rawListeners = new Set<RawListener>();
  private readonly outboundEvents: string[] = [];
  private readonly deletedProviderItems = new Set<string>();
  private unsubscribeRuntime: (() => void) | null = null;
  private eventTail: Promise<void> = Promise.resolve();
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private closeNotified = false;
  private generation = 0;
  private assistantTranscript = "";
  private lastResponseInstructions = "";
  private userSpeechStartedAtMs: number | null = null;
  private userSpeechDurationMs: number | undefined;
  private assistantAudioStartedAtMs: number | null = null;
  private assistantAudioDurationMs: number | undefined;
  private responseRequestedAtMs: number | null = null;
  private snapshotValue: OpenAISipSidebandSnapshot;

  constructor(private readonly options: OpenAISipSidebandOptions) {
    if (!options.apiKey.trim()) throw new Error("An OpenAI API key is required.");
    const id = safeCallId(options.callId);
    this.snapshotValue = {
      callId: id,
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
      runtime: null,
    };
    this.unsubscribeRuntime = options.runtimeSession.subscribe((runtime) => {
      this.patch({ runtime });
    });
  }

  get snapshot(): OpenAISipSidebandSnapshot {
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

  async close(reason = "application-ended"): Promise<void> {
    if (this.intentionalClose && (this.snapshotValue.status === "closed" || this.snapshotValue.status === "idle")) return;
    this.intentionalClose = true;
    this.generation += 1;
    this.clearTimers();
    this.patch({ status: "closing" });
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason.slice(0, 120));
    await this.recordDisconnected(reason);
    this.patch({ status: "closed", disconnectedAt: now() });
    await this.notifyClose();
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const providerItemId = `item_${crypto.randomUUID().replaceAll("-", "")}`;
    this.send({
      type: "conversation.item.create",
      item: {
        id: providerItemId,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: trimmed }],
      },
    });
    const startedAt = Date.now();
    const prepared = await this.options.runtimeSession.prepareTextTurn(trimmed, { providerItemId });
    this.patch({ lastTurnPreparationMs: Date.now() - startedAt });
    await this.applyPreparedTurn(prepared);
  }

  dispose(): void {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.listeners.clear();
    this.rawListeners.clear();
    void this.close("disposed");
  }

  private async open(generation: number): Promise<void> {
    const factory = this.options.webSocketFactory ?? ((url, options) => new WebSocket(url, options) as OpenAISipSidebandSocket);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      ...(this.options.safetyIdentifier ? { "OpenAI-Safety-Identifier": this.options.safetyIdentifier } : {}),
    };
    const url = this.options.url
      ?? `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.snapshotValue.callId)}`;
    const socket = factory(url, { headers });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate?.();
        reject(new Error("Realtime SIP sideband connection timed out."));
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
        this.patch({
          status: "error",
          error: error instanceof Error ? error.message : "Could not connect the SIP sideband channel.",
        });
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
    this.flush();
    this.startDurationTimer();
    if (this.options.initialResponseInstructions) {
      this.send({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: this.options.initialResponseInstructions,
        },
      });
      this.responseRequestedAtMs = Date.now();
    }
  }

  private bindSocket(socket: OpenAISipSidebandSocket, generation: number): void {
    socket.on("message", (data) => {
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(decodeMessage(data));
        const record = asRecord(parsed);
        if (!record) throw new Error("Expected an object event.");
        event = record;
      } catch {
        this.patch({ error: "Received an invalid Realtime sideband event." });
        return;
      }
      this.eventTail = this.eventTail
        .then(() => this.handleProviderEvent(event))
        .catch((error) => {
          this.patch({ error: error instanceof Error ? error.message : "Could not process a sideband event." });
        });
    });
    socket.on("close", (code, reason) => {
      if (generation !== this.generation) return;
      this.socket = null;
      const detail = reason.toString("utf8") || `code-${code}`;
      if (this.intentionalClose) return;
      void this.recordDisconnected(`sideband-${detail}`);
      this.scheduleReconnect(detail);
    });
  }

  private async handleProviderEvent(event: Record<string, unknown>): Promise<void> {
    const type = readString(event, "type");
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

    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      this.assistantTranscript += readString(event, "delta");
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      this.assistantTranscript = "";
    }
    if (type === "response.function_call_arguments.done") await this.executeToolCall(event);
    if (type === "error") {
      const error = asRecord(event.error);
      this.patch({ error: error ? readString(error, "message", "code") : "OpenAI Realtime SIP error." });
    }
  }

  private mapProviderEvent(event: Record<string, unknown>): ConversationEvent | null {
    const type = readString(event, "type");
    const at = now();
    if (type === "input_audio_buffer.speech_started") {
      this.userSpeechStartedAtMs = Date.now();
      return { type: "user.speech.started", at };
    }
    if (type === "input_audio_buffer.speech_stopped") {
      if (this.userSpeechStartedAtMs !== null) {
        this.userSpeechDurationMs = Math.max(250, Date.now() - this.userSpeechStartedAtMs);
        this.userSpeechStartedAtMs = null;
      }
      return { type: "user.speech.stopped", at };
    }
    if (type === "conversation.item.input_audio_transcription.delta") {
      return { type: "user.transcript.delta", text: readString(event, "delta"), at };
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const providerItemId = readString(event, "item_id");
      const audio = this.audioRef(providerItemId, this.userSpeechDurationMs, "input");
      this.userSpeechDurationMs = undefined;
      return {
        type: "user.transcript.completed",
        text: readString(event, "transcript"),
        at,
        ...(audio ? { audio } : {}),
        ...(providerItemId ? { providerItemId } : {}),
      };
    }
    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      return { type: "assistant.transcript.delta", text: readString(event, "delta"), at };
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      const providerItemId = readString(event, "item_id");
      const audio = this.audioRef(providerItemId, this.assistantAudioDurationMs, "output");
      this.assistantAudioDurationMs = undefined;
      return {
        type: "assistant.transcript.completed",
        text: readString(event, "transcript") || this.assistantTranscript,
        at,
        ...(audio ? { audio } : {}),
        ...(providerItemId ? { providerItemId } : {}),
      };
    }
    if (
      type === "output_audio_buffer.started"
      || type === "response.output_audio.delta"
      || type === "response.audio.delta"
    ) {
      if (this.assistantAudioStartedAtMs === null) this.assistantAudioStartedAtMs = Date.now();
      if (this.responseRequestedAtMs !== null) {
        this.patch({ firstAudioLatencyMs: Math.max(0, Date.now() - this.responseRequestedAtMs) });
        this.responseRequestedAtMs = null;
      }
      return { type: "assistant.audio.started", at };
    }
    if (
      type === "output_audio_buffer.stopped"
      || type === "response.output_audio.done"
      || type === "response.audio.done"
    ) {
      if (this.assistantAudioStartedAtMs !== null) {
        this.assistantAudioDurationMs = Math.max(250, Date.now() - this.assistantAudioStartedAtMs);
        this.assistantAudioStartedAtMs = null;
      }
      return { type: "assistant.audio.stopped", at };
    }
    if (type === "conversation.item.truncated" || type === "response.cancelled") {
      return { type: "response.interrupted", at };
    }
    if (type === "response.done") {
      const response = asRecord(event.response);
      const usage = response ? asRecord(response.usage) : null;
      const inputDetails = usage ? asRecord(usage.input_token_details) : null;
      const inputTokens = Number(usage?.input_tokens ?? 0);
      const outputTokens = Number(usage?.output_tokens ?? 0);
      const cachedInputTokens = Number(inputDetails?.cached_tokens ?? 0);
      this.patch({
        inputTokens: this.snapshotValue.inputTokens + inputTokens,
        outputTokens: this.snapshotValue.outputTokens + outputTokens,
        cachedInputTokens: this.snapshotValue.cachedInputTokens + cachedInputTokens,
      });
      void this.enforceTokenLimit();
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
      this.options.baseInstructions ?? "Respond naturally and concisely in the caller's language.",
      prepared.context.rendered,
      ...modelInstructions,
    ].filter(Boolean).join("\n\n");
    this.lastResponseInstructions = instructions;
    this.send({
      type: "response.create",
      response: { output_modalities: ["audio"], instructions },
    });
    this.responseRequestedAtMs = Date.now();
  }

  private reconcileProviderConversation(prepared: PreparedTurn): void {
    if (this.options.manageProviderConversation === false) return;
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
        this.send({ type: "conversation.item.delete", item_id: itemId });
        this.deletedProviderItems.add(itemId);
      }
    }
  }

  private applyDirectives(directives: Directive[]): void {
    for (const directive of directives) {
      if (directive.type === "turn.setSilence") {
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input: {
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: directive.milliseconds,
                  create_response: false,
                  interrupt_response: true,
                },
              },
            },
          },
        });
      }
      if (directive.type === "voice.setPace") {
        this.send({
          type: "session.update",
          session: {
            type: "realtime",
            audio: { output: { speed: Math.min(1.5, Math.max(0.25, directive.rate)) } },
          },
        });
      }
      if (directive.type === "response.pause") {
        this.send({ type: "response.cancel" });
        this.send({ type: "output_audio_buffer.clear" });
      }
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
    let parsedArguments: unknown = {};
    try {
      parsedArguments = JSON.parse(readString(event, "arguments") || "{}");
    } catch {
      parsedArguments = { raw: readString(event, "arguments") };
    }
    let output: unknown;
    try {
      if (!this.options.onToolCall) throw new Error(`No server tool handler is registered for ${name}.`);
      output = await this.options.onToolCall({ callId, name, arguments: parsedArguments });
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
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        ...(this.lastResponseInstructions ? { instructions: this.lastResponseInstructions } : {}),
      },
    });
  }

  private audioRef(itemId: string, durationMs: number | undefined, direction: "input" | "output"): AudioRef | undefined {
    if (!itemId || !durationMs) return undefined;
    return {
      uri: `realtime-sip://${this.options.runtimeSession.sessionId}/${direction}/${itemId}`,
      durationMs,
      mimeType: "audio/pcm;rate=24000",
      persisted: false,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  }

  private send(event: Record<string, unknown>): void {
    const serialized = JSON.stringify(event);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (this.intentionalClose || this.snapshotValue.status === "closed" || this.snapshotValue.status === "error") {
      this.patch({ error: "Realtime SIP event could not be sent because the sideband channel is closed." });
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
      this.patch({ status: "error", error: `SIP sideband unavailable after ${maxAttempts} reconnect attempts (${reason}).` });
      void this.notifyClose();
      return;
    }
    const attempt = this.snapshotValue.reconnectAttempts + 1;
    const delay = Math.min(
      Math.max(250, config.maxDelayMs ?? 5_000),
      Math.max(100, config.initialDelayMs ?? 300) * 2 ** (attempt - 1),
    );
    this.patch({ status: "reconnecting", reconnectAttempts: attempt, error: `SIP sideband disconnected (${reason}); retrying.` });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect("connect-error"));
    }, delay);
  }

  private startDurationTimer(): void {
    if (!this.options.maxDurationMs || this.durationTimer) return;
    this.durationTimer = setTimeout(() => {
      void Promise.resolve(this.options.onLimit?.("duration")).catch(() => undefined);
    }, Math.max(1_000, this.options.maxDurationMs));
  }

  private async enforceTokenLimit(): Promise<void> {
    const max = this.options.maxTotalTokens;
    const used = this.snapshotValue.inputTokens + this.snapshotValue.outputTokens;
    if (max && used >= max) await this.options.onLimit?.("tokens");
  }

  private async recordDisconnected(reason: string): Promise<void> {
    await this.options.runtimeSession.ingest({
      type: "session.disconnected",
      sessionId: this.options.runtimeSession.sessionId,
      at: now(),
      reason,
    }).catch(() => undefined);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.reconnectTimer = null;
    this.durationTimer = null;
  }

  private async notifyClose(): Promise<void> {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.clearTimers();
    await this.options.onClose?.(this.snapshot);
  }

  private patch(patch: Partial<OpenAISipSidebandSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
