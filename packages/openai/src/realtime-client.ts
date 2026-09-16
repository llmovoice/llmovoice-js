import type { AudioRef, ConversationEvent, Directive, DirectiveExecutor, EnvironmentState } from "@llmovoice/core";
import type { LlmovoiceSession, PreparedTurn, RuntimeSnapshot } from "@llmovoice/runtime";

export type RealtimeClientStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnecting" | "error";

export interface RealtimeClientOptions {
  tokenEndpoint: string;
  runtimeSession: LlmovoiceSession;
  audioElement?: HTMLAudioElement;
  baseInstructions?: string;
  callsEndpoint?: string;
  tokenHeaders?: () => HeadersInit | Promise<HeadersInit>;
  telemetryIntervalMs?: number;
  directiveExecutors?: DirectiveExecutor[];
  manageProviderConversation?: boolean;
  connectionTimeoutMs?: number;
  dataChannelOpenTimeoutMs?: number;
  maxBufferedEvents?: number;
  maxBufferedAmountBytes?: number;
  reconnect?: false | {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
}

export interface RealtimePerformanceSnapshot {
  connectionSetupMs: number | null;
  lastTurnPreparationMs: number | null;
  firstAudioLatencyMs: number | null;
  telemetrySamples: number;
  reconnectAttempts: number;
  queuedOutboundEvents: number;
  droppedOutboundEvents: number;
}

export interface RealtimeClientSnapshot {
  status: RealtimeClientStatus;
  muted: boolean;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  error: string | null;
  rawEventCount: number;
  runtime: RuntimeSnapshot | null;
  performance: RealtimePerformanceSnapshot;
}

type SnapshotListener = (snapshot: RealtimeClientSnapshot) => void;
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

export class OpenAIRealtimeClient {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null;
  private unsubscribeRuntime: (() => void) | null = null;
  private listeners = new Set<SnapshotListener>();
  private rawListeners = new Set<RawListener>();
  private assistantTranscript = "";
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private userSpeechStartedAtMs: number | null = null;
  private userSpeechDurationMs: number | undefined;
  private assistantAudioStartedAtMs: number | null = null;
  private assistantAudioDurationMs: number | undefined;
  private deletedProviderItems = new Set<string>();
  private connectController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveReconnectAttempts = 0;
  private connectionGeneration = 0;
  private intentionalDisconnect = false;
  private providerEventTail: Promise<void> = Promise.resolve();
  private readonly outboundEvents: string[] = [];
  private telemetryInFlight = false;
  private previousPackets: { sent: number; lost: number } | null = null;
  private smoothedTelemetry: { rtt: number; jitter: number; loss: number } | null = null;
  private lastTelemetryPublished: { rtt: number; jitter: number; loss: number } | null = null;
  private responseRequestedAtMs: number | null = null;
  private snapshotValue: RealtimeClientSnapshot = {
    status: "idle",
    muted: false,
    userSpeaking: false,
    assistantSpeaking: false,
    error: null,
    rawEventCount: 0,
    runtime: null,
    performance: {
      connectionSetupMs: null,
      lastTurnPreparationMs: null,
      firstAudioLatencyMs: null,
      telemetrySamples: 0,
      reconnectAttempts: 0,
      queuedOutboundEvents: 0,
      droppedOutboundEvents: 0,
    },
  };

  constructor(private readonly options: RealtimeClientOptions) {
    this.audioElement = options.audioElement ?? null;
    this.unsubscribeRuntime = options.runtimeSession.subscribe((runtime) => {
      this.patch({ runtime });
    });
  }

  get snapshot(): RealtimeClientSnapshot {
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
    if (this.snapshotValue.status === "connecting" || this.snapshotValue.status === "connected") return;
    const startedAt = performance.now();
    const generation = ++this.connectionGeneration;
    this.intentionalDisconnect = false;
    this.connectController?.abort();
    const controller = new AbortController();
    this.connectController = controller;
    this.patch({ status: "connecting", error: null });

    try {
      const tokenHeaders = await this.options.tokenHeaders?.();
      const tokenResponse = await fetch(this.options.tokenEndpoint, {
        method: "POST",
        ...(tokenHeaders ? { headers: tokenHeaders } : {}),
        signal: this.connectionSignal(controller.signal),
      });
      const tokenData = await tokenResponse.json() as { value?: string; error?: string };
      if (!tokenResponse.ok || !tokenData.value) {
        throw new Error(tokenData.error ?? "The server did not return a Realtime client secret.");
      }

      const pc = new RTCPeerConnection();
      if (generation !== this.connectionGeneration) throw new Error("Realtime connection was superseded.");
      this.peerConnection = pc;
      const audio = this.audioElement ?? document.createElement("audio");
      audio.autoplay = true;
      this.audioElement = audio;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") this.scheduleReconnect("webrtc-failed");
        if (pc.connectionState === "disconnected") this.scheduleReconnect("webrtc-disconnected");
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream = stream;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const channel = pc.createDataChannel("oai-events");
      this.dataChannel = channel;
      channel.bufferedAmountLowThreshold = Math.floor(this.maxBufferedAmount() / 2);
      channel.onopen = () => this.flushOutboundEvents();
      channel.onbufferedamountlow = () => this.flushOutboundEvents();
      channel.onclose = () => {
        if (!this.intentionalDisconnect) this.scheduleReconnect("data-channel-closed");
      };
      channel.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as Record<string, unknown>;
          this.providerEventTail = this.providerEventTail
            .then(() => this.handleProviderEvent(event))
            .catch((error) => {
              this.patch({ error: error instanceof Error ? error.message : "Could not process Realtime event." });
            });
        } catch (error) {
          this.patch({ error: error instanceof Error ? error.message : "Invalid Realtime event." });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("The browser did not produce a WebRTC SDP offer.");
      const sdpResponse = await fetch(this.options.callsEndpoint ?? "https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${tokenData.value}`,
          "Content-Type": "application/sdp",
        },
        signal: this.connectionSignal(controller.signal),
      });
      if (!sdpResponse.ok) throw new Error(`Realtime WebRTC handshake failed (${sdpResponse.status}).`);
      await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
      await this.waitForDataChannel(channel, controller.signal);
      if (generation !== this.connectionGeneration) throw new Error("Realtime connection was superseded.");
      await this.options.runtimeSession.ingest({
        type: "session.connected",
        sessionId: this.options.runtimeSession.sessionId,
        at: now(),
      });
      this.startTelemetry();
      this.consecutiveReconnectAttempts = 0;
      this.patchPerformance({ connectionSetupMs: Number((performance.now() - startedAt).toFixed(2)) });
      this.patch({ status: "connected" });
    } catch (error) {
      if (generation !== this.connectionGeneration || controller.signal.aborted && this.intentionalDisconnect) return;
      this.cleanupTransport();
      this.patch({
        status: "error",
        error: error instanceof Error ? error.message : "Could not start the Realtime call.",
      });
      if (!this.intentionalDisconnect && this.consecutiveReconnectAttempts > 0) this.scheduleReconnect("connect-error");
      throw error;
    } finally {
      if (this.connectController === controller) this.connectController = null;
    }
  }

  async disconnect(reason = "user-ended"): Promise<void> {
    if (this.snapshotValue.status === "idle") return;
    this.intentionalDisconnect = true;
    this.connectionGeneration += 1;
    this.connectController?.abort();
    this.connectController = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.patch({ status: "disconnecting" });
    this.cleanupTransport();
    await this.options.runtimeSession.ingest({
      type: "session.disconnected",
      sessionId: this.options.runtimeSession.sessionId,
      at: now(),
      reason,
    });
    this.patch({ status: "idle", userSpeaking: false, assistantSpeaking: false });
  }

  setMuted(muted: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.patch({ muted });
  }

  async sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.snapshotValue.status !== "connected" || this.dataChannel?.readyState !== "open") {
      throw new Error("Realtime data channel is not connected.");
    }
    const startedAt = performance.now();
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
    const prepared = await this.options.runtimeSession.prepareTextTurn(trimmed, { providerItemId });
    this.patchPerformance({ lastTurnPreparationMs: Number((performance.now() - startedAt).toFixed(2)) });
    this.applyPreparedTurn(prepared);
  }

  updateEnvironment(
    input: Pick<EnvironmentState, "latencyMs" | "jitterMs" | "packetLoss"> & Partial<EnvironmentState>,
    source: "application" | "webrtc" = "application",
  ): void {
    void this.options.runtimeSession.ingest({
      type: "environment.updated",
      environment: input,
      at: now(),
      source,
    }).then(() => {
      const directives = this.snapshotValue.runtime?.orchestration?.directives ?? [];
      this.applyDirectives(directives, true);
    });
  }

  dispose(): void {
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.listeners.clear();
    this.rawListeners.clear();
    void this.disconnect("disposed");
  }

  private async handleProviderEvent(event: Record<string, unknown>): Promise<void> {
    const type = readString(event, "type");
    this.snapshotValue.rawEventCount += 1;
    for (const listener of this.rawListeners) listener(event);

    const mapped = this.mapProviderEvent(event);
    if (mapped) {
      const turnStartedAt = mapped.type === "user.transcript.completed" ? performance.now() : null;
      const prepared = await this.options.runtimeSession.ingest(mapped);
      if (prepared) {
        if (turnStartedAt !== null) {
          this.patchPerformance({ lastTurnPreparationMs: Number((performance.now() - turnStartedAt).toFixed(2)) });
        }
        this.applyPreparedTurn(prepared);
      }
    }

    if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
      this.assistantTranscript += readString(event, "delta");
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      this.assistantTranscript = "";
    }

    if (type === "error") {
      const error = asRecord(event.error);
      this.patch({ error: error ? readString(error, "message", "code") : "OpenAI Realtime error." });
    } else {
      this.emit();
    }
  }

  private mapProviderEvent(event: Record<string, unknown>): ConversationEvent | null {
    const type = readString(event, "type");
    const at = now();
    if (type === "input_audio_buffer.speech_started") {
      this.userSpeechStartedAtMs = Date.now();
      this.patch({ userSpeaking: true });
      return { type: "user.speech.started", at };
    }
    if (type === "input_audio_buffer.speech_stopped") {
      if (this.userSpeechStartedAtMs !== null) {
        this.userSpeechDurationMs = Math.max(250, Date.now() - this.userSpeechStartedAtMs);
        this.userSpeechStartedAtMs = null;
      }
      this.patch({ userSpeaking: false });
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
      this.patch({ assistantSpeaking: true });
      return { type: "assistant.transcript.delta", text: readString(event, "delta"), at };
    }
    if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
      this.patch({ assistantSpeaking: false });
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
    if (type === "output_audio_buffer.started" || type === "response.audio.delta") {
      if (this.assistantAudioStartedAtMs === null) this.assistantAudioStartedAtMs = Date.now();
      if (this.responseRequestedAtMs !== null) {
        this.patchPerformance({ firstAudioLatencyMs: Math.max(0, Date.now() - this.responseRequestedAtMs) });
        this.responseRequestedAtMs = null;
      }
      this.patch({ assistantSpeaking: true });
      return { type: "assistant.audio.started", at };
    }
    if (type === "output_audio_buffer.stopped" || type === "response.audio.done") {
      if (this.assistantAudioStartedAtMs !== null) {
        this.assistantAudioDurationMs = Math.max(250, Date.now() - this.assistantAudioStartedAtMs);
        this.assistantAudioStartedAtMs = null;
      }
      this.patch({ assistantSpeaking: false });
      return { type: "assistant.audio.stopped", at };
    }
    if (type === "conversation.item.truncated") return { type: "response.interrupted", at };
    if (type === "response.done") {
      const response = asRecord(event.response);
      const usage = response ? asRecord(response.usage) : null;
      const inputDetails = usage ? asRecord(usage.input_token_details) : null;
      return {
        type: "response.usage",
        inputTokens: Number(usage?.input_tokens ?? 0),
        outputTokens: Number(usage?.output_tokens ?? 0),
        cachedInputTokens: Number(inputDetails?.cached_tokens ?? 0),
        at,
      };
    }
    return null;
  }

  private applyPreparedTurn(prepared: PreparedTurn): void {
    this.applyDirectives(prepared.orchestration.directives);
    this.reconcileProviderConversation(prepared);
    const instructions = [
      this.options.baseInstructions ?? "Respond naturally and concisely in the user's language.",
      prepared.context.rendered,
    ].filter(Boolean).join("\n\n");
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions,
      },
    });
    this.responseRequestedAtMs = Date.now();
  }

  private reconcileProviderConversation(prepared: PreparedTurn): void {
    if (this.options.manageProviderConversation === false) return;
    const snapshot = this.snapshotValue.runtime;
    if (!snapshot) return;
    const preserveAudioPages = new Set(
      prepared.context.items
        .filter((item) => item.unitKind === "page" && item.fidelity === "audio")
        .map((item) => item.unitId),
    );
    preserveAudioPages.add(prepared.page.id);
    for (const page of snapshot.pages) {
      if (preserveAudioPages.has(page.id)) continue;
      for (const itemId of [page.input.providerItemId, page.output?.providerItemId]) {
        if (!itemId || this.deletedProviderItems.has(itemId)) continue;
        this.send({ type: "conversation.item.delete", item_id: itemId });
        this.deletedProviderItems.add(itemId);
      }
    }
  }

  private applyDirectives(directives: Directive[], environmentOnly = false): void {
    const silence = directives.find((directive) => directive.type === "turn.setSilence");
    if (silence?.type === "turn.setSilence") {
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
                silence_duration_ms: silence.milliseconds,
                create_response: false,
                interrupt_response: true,
              },
            },
          },
        },
      });
    }
    if (environmentOnly) return;

    const pace = directives.find((directive) => directive.type === "voice.setPace");
    if (pace?.type === "voice.setPace") {
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          audio: { output: { speed: Math.min(1.5, Math.max(0.25, pace.rate)) } },
        },
      });
    }

    if (directives.some((directive) => directive.type === "response.pause")) {
      if (this.snapshotValue.assistantSpeaking) {
        this.send({ type: "response.cancel" });
        this.send({ type: "output_audio_buffer.clear" });
      }
      this.audioElement?.pause();
    }
    if (directives.some((directive) => directive.type === "response.resume") && this.audioElement?.paused) {
      void this.audioElement.play().catch(() => undefined);
    }

    for (const directive of directives) {
      if (directive.type === "context.archiveThread") {
        void this.options.runtimeSession.archiveThread(directive.threadId).catch(() => undefined);
      }
      if (directive.type.startsWith("app.") || directive.type.startsWith("tool.")) {
        for (const executor of this.options.directiveExecutors ?? []) {
          void Promise.resolve(executor.execute(directive)).catch(() => undefined);
        }
      }
    }
  }

  private audioRef(itemId: string, durationMs: number | undefined, direction: "input" | "output"): AudioRef | undefined {
    if (!itemId || !durationMs) return undefined;
    return {
      uri: `realtime://${this.options.runtimeSession.sessionId}/${direction}/${itemId}`,
      durationMs,
      mimeType: "audio/pcm;rate=24000",
      persisted: false,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
  }

  private startTelemetry(): void {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    const interval = Math.max(1_000, this.options.telemetryIntervalMs ?? 2_000);
    this.telemetryTimer = setInterval(() => void this.sampleTelemetry(), interval);
    void this.sampleTelemetry();
  }

  private async sampleTelemetry(): Promise<void> {
    const pc = this.peerConnection;
    if (!pc || pc.connectionState === "closed" || this.telemetryInFlight) return;
    this.telemetryInFlight = true;
    try {
      const stats = await pc.getStats();
      let roundTripTimeMs = 0;
      let jitterMs = 0;
      let packetsSent = 0;
      let packetsLost = 0;
      let availableOutgoingBitrateKbps = 0;
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
          roundTripTimeMs = Number(report.currentRoundTripTime ?? 0) * 1_000;
          availableOutgoingBitrateKbps = Number(report.availableOutgoingBitrate ?? 0) / 1_000;
        }
        if (report.type === "outbound-rtp" && report.kind === "audio") packetsSent = Number(report.packetsSent ?? 0);
        if (report.type === "remote-inbound-rtp" && report.kind === "audio") {
          packetsLost = Number(report.packetsLost ?? 0);
          jitterMs = Number(report.jitter ?? 0) * 1_000;
          if (!roundTripTimeMs) roundTripTimeMs = Number(report.roundTripTime ?? 0) * 1_000;
        }
      });
      const sentDelta = this.previousPackets ? Math.max(0, packetsSent - this.previousPackets.sent) : packetsSent;
      const lostDelta = this.previousPackets ? Math.max(0, packetsLost - this.previousPackets.lost) : Math.max(0, packetsLost);
      this.previousPackets = { sent: packetsSent, lost: packetsLost };
      const denominator = sentDelta + lostDelta;
      const packetLoss = denominator > 0 ? lostDelta / denominator : 0;
      if (roundTripTimeMs || jitterMs || packetsSent) {
        const alpha = 0.3;
        this.smoothedTelemetry = this.smoothedTelemetry
          ? {
              rtt: this.smoothedTelemetry.rtt * (1 - alpha) + roundTripTimeMs * alpha,
              jitter: this.smoothedTelemetry.jitter * (1 - alpha) + jitterMs * alpha,
              loss: this.smoothedTelemetry.loss * (1 - alpha) + packetLoss * alpha,
            }
          : { rtt: roundTripTimeMs, jitter: jitterMs, loss: packetLoss };
        const sample = this.smoothedTelemetry;
        this.patchPerformance({ telemetrySamples: this.snapshotValue.performance.telemetrySamples + 1 });
        if (!this.shouldPublishTelemetry(sample)) return;
        this.lastTelemetryPublished = { ...sample };
        this.updateEnvironment({
          latencyMs: Math.round(sample.rtt / 2),
          jitterMs: Math.round(sample.jitter),
          packetLoss: sample.loss,
          roundTripTimeMs: Math.round(sample.rtt),
          availableOutgoingBitrateKbps: Math.round(availableOutgoingBitrateKbps),
          packetsSent,
          packetsLost,
        }, "webrtc");
      }
    } catch {
      // Browser telemetry is best effort and must never interrupt the call.
    } finally {
      this.telemetryInFlight = false;
    }
  }

  private send(event: Record<string, unknown>): void {
    const serialized = JSON.stringify(event);
    const channel = this.dataChannel;
    if (channel?.readyState === "open" && Number(channel.bufferedAmount ?? 0) < this.maxBufferedAmount()) {
      channel.send(serialized);
      return;
    }
    const canBuffer = channel?.readyState === "open"
      || channel?.readyState === "connecting"
      || this.snapshotValue.status === "connecting"
      || this.snapshotValue.status === "reconnecting";
    if (!canBuffer) {
      this.patch({ error: "Realtime event could not be sent because the data channel is closed." });
      return;
    }
    const max = Math.max(1, this.options.maxBufferedEvents ?? 128);
    if (this.outboundEvents.length >= max) {
      this.outboundEvents.shift();
      this.patchPerformance({ droppedOutboundEvents: this.snapshotValue.performance.droppedOutboundEvents + 1 });
    }
    this.outboundEvents.push(serialized);
    this.patchPerformance({ queuedOutboundEvents: this.outboundEvents.length });
  }

  private flushOutboundEvents(): void {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open") return;
    while (this.outboundEvents.length > 0 && Number(channel.bufferedAmount ?? 0) < this.maxBufferedAmount()) {
      channel.send(this.outboundEvents.shift()!);
    }
    this.patchPerformance({ queuedOutboundEvents: this.outboundEvents.length });
  }

  private maxBufferedAmount(): number {
    return Math.max(16_384, this.options.maxBufferedAmountBytes ?? 262_144);
  }

  private connectionSignal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1_000, this.options.connectionTimeoutMs ?? 15_000)),
    ]);
  }

  private async waitForDataChannel(channel: RTCDataChannel, signal: AbortSignal): Promise<void> {
    if (channel.readyState === "open") return;
    const waitSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(500, this.options.dataChannelOpenTimeoutMs ?? 8_000)),
    ]);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener("open", onOpen);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onError);
        waitSignal.removeEventListener("abort", onAbort);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error("Realtime data channel closed before opening.")); };
      const onError = () => { cleanup(); reject(new Error("Realtime data channel failed to open.")); };
      const onAbort = () => { cleanup(); reject(waitSignal.reason ?? new Error("Realtime connection timed out.")); };
      channel.addEventListener("open", onOpen, { once: true });
      channel.addEventListener("close", onClose, { once: true });
      channel.addEventListener("error", onError, { once: true });
      waitSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.intentionalDisconnect || this.options.reconnect === false || this.reconnectTimer) return;
    const config = this.options.reconnect ?? {};
    const maxAttempts = Math.max(0, config.maxAttempts ?? 3);
    if (this.consecutiveReconnectAttempts >= maxAttempts) {
      this.cleanupTransport();
      this.patch({ status: "error", error: `Realtime connection unavailable after ${maxAttempts} reconnect attempts.` });
      return;
    }
    this.consecutiveReconnectAttempts += 1;
    this.patchPerformance({ reconnectAttempts: this.snapshotValue.performance.reconnectAttempts + 1 });
    const delay = Math.min(
      Math.max(250, config.maxDelayMs ?? 8_000),
      Math.max(100, config.initialDelayMs ?? 500) * 2 ** (this.consecutiveReconnectAttempts - 1),
    );
    this.connectionGeneration += 1;
    this.connectController?.abort();
    this.connectController = null;
    this.cleanupTransport();
    this.patch({ status: "reconnecting", error: `Realtime connection lost (${reason}); retrying.` });
    void this.options.runtimeSession.ingest({
      type: "session.disconnected",
      sessionId: this.options.runtimeSession.sessionId,
      at: now(),
      reason,
    }).catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private cleanupTransport(): void {
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
    if (this.dataChannel) {
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onopen = null;
      this.dataChannel.onbufferedamountlow = null;
      this.dataChannel.close();
    }
    this.peerConnection?.close();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    if (this.audioElement) this.audioElement.srcObject = null;
    this.dataChannel = null;
    this.peerConnection = null;
    this.localStream = null;
    this.previousPackets = null;
    this.smoothedTelemetry = null;
    this.lastTelemetryPublished = null;
    this.responseRequestedAtMs = null;
    this.deletedProviderItems.clear();
    if (this.outboundEvents.length > 0) {
      this.patchPerformance({
        queuedOutboundEvents: 0,
        droppedOutboundEvents: this.snapshotValue.performance.droppedOutboundEvents + this.outboundEvents.length,
      });
      this.outboundEvents.length = 0;
    }
  }

  private shouldPublishTelemetry(sample: { rtt: number; jitter: number; loss: number }): boolean {
    const previous = this.lastTelemetryPublished;
    if (!previous) return true;
    return Math.abs(sample.rtt - previous.rtt) >= Math.max(20, previous.rtt * 0.15)
      || Math.abs(sample.jitter - previous.jitter) >= Math.max(10, previous.jitter * 0.25)
      || Math.abs(sample.loss - previous.loss) >= 0.01;
  }

  private patchPerformance(patch: Partial<RealtimePerformanceSnapshot>): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      performance: { ...this.snapshotValue.performance, ...patch },
    };
    this.emit();
  }

  private patch(patch: Partial<RealtimeClientSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
