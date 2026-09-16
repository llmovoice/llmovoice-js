import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmovoice } from "@llmovoice/runtime";
import { OpenAIRealtimeClient } from "./realtime-client";

class FakeDataChannel {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  sent: Array<Record<string, unknown>> = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = "closed"; }
  event(value: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = "connected";
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channel = new FakeDataChannel();
  addTrack() { return {} as RTCRtpSender; }
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  async createOffer() { return { type: "offer" as RTCSdpType, sdp: "offer-sdp" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.connectionState = "closed"; }
  async getStats() {
    const reports = [
      { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.12, availableOutgoingBitrate: 640_000 },
      { type: "outbound-rtp", kind: "audio", packetsSent: 100 },
      { type: "remote-inbound-rtp", kind: "audio", packetsLost: 2, jitter: 0.02 },
    ];
    return { forEach(callback: (report: Record<string, unknown>) => void) { reports.forEach(callback); } } as unknown as RTCStatsReport;
  }
}

let peer: FakePeerConnection;
let audio: HTMLAudioElement;

beforeEach(() => {
  peer = new FakePeerConnection();
  vi.stubGlobal("RTCPeerConnection", class { constructor() { return peer; } });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      async getUserMedia() {
        return { getTracks: () => [{ stop: vi.fn(), enabled: true }], getAudioTracks: () => [{ enabled: true }] };
      },
    },
  });
  audio = {
    autoplay: true,
    paused: true,
    srcObject: null,
    play: vi.fn(async function (this: { paused: boolean }) { this.paused = false; }),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
  } as unknown as HTMLAudioElement;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/token") return new Response(JSON.stringify({ value: "ek_test" }), { status: 200 });
    return new Response("answer-sdp", { status: 200, headers: { "Content-Type": "application/sdp" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAIRealtimeClient", () => {
  it("connects, compiles audio turns, applies directives, trims provider history, and disconnects", async () => {
    const runtime = createLlmovoice({ compiler: { budget: { maxInputTokens: 80, reservedOutputTokens: 30 } } });
    const session = runtime.createSession({ userId: "u1", sessionId: "realtime-test" });
    const client = new OpenAIRealtimeClient({ tokenEndpoint: "/token", runtimeSession: session, audioElement: audio, telemetryIntervalMs: 60_000 });
    await client.connect();
    expect(client.snapshot.status).toBe("connected");
    expect(client.snapshot.performance.connectionSetupMs).not.toBeNull();
    peer.channel.bufferedAmount = 300_000;
    (client as unknown as { send(value: Record<string, unknown>): void }).send({ type: "session.update", probe: true });
    expect(client.snapshot.performance.queuedOutboundEvents).toBe(1);
    peer.channel.bufferedAmount = 0;
    peer.channel.onbufferedamountlow?.();
    expect(client.snapshot.performance.queuedOutboundEvents).toBe(0);
    expect(peer.channel.sent.some((event) => event.probe === true)).toBe(true);
    const providerEvent = (event: Record<string, unknown>) =>
      (client as unknown as { handleProviderEvent(value: Record<string, unknown>): Promise<void> }).handleProviderEvent(event);
    const mappedProbe = (client as unknown as { mapProviderEvent(value: Record<string, unknown>): unknown }).mapProviderEvent({
      type: "conversation.item.input_audio_transcription.completed", item_id: "probe_item", transcript: "probe",
    });
    expect(mappedProbe).toMatchObject({ providerItemId: "probe_item" });

    await providerEvent({ type: "input_audio_buffer.speech_started" });
    await providerEvent({ type: "input_audio_buffer.speech_stopped" });
    const mappedUser = (client as unknown as { mapProviderEvent(value: Record<string, unknown>): Parameters<typeof session.ingest>[0] }).mapProviderEvent({
      type: "conversation.item.input_audio_transcription.completed", item_id: "item_user_1", transcript: "remember my dog friendly hotel",
    });
    expect(mappedUser).toMatchObject({ providerItemId: "item_user_1" });
    const preparedUser = await session.ingest(mappedUser);
    if (preparedUser) (client as unknown as { applyPreparedTurn(value: typeof preparedUser): void }).applyPreparedTurn(preparedUser);
    expect((await session.snapshot()).pages[0]?.input.providerItemId).toBe("item_user_1");
    await vi.waitFor(() => expect(peer.channel.sent.some((event) => event.type === "response.create")).toBe(true));
    expect(peer.channel.sent.some((event) => event.type === "session.update")).toBe(true);

    await providerEvent({ type: "output_audio_buffer.started" });
    (client as unknown as { applyDirectives(value: Array<{ type: "response.pause"; reason: string }>): void })
      .applyDirectives([{ type: "response.pause", reason: "test interruption" }]);
    expect(peer.channel.sent.some((event) => event.type === "response.cancel")).toBe(true);
    expect(peer.channel.sent.some((event) => event.type === "output_audio_buffer.clear")).toBe(true);
    expect(client.snapshot.performance.firstAudioLatencyMs).not.toBeNull();
    await providerEvent({ type: "response.output_audio_transcript.delta", delta: "I remember " });
    await providerEvent({ type: "output_audio_buffer.stopped" });
    await providerEvent({ type: "response.output_audio_transcript.done", item_id: "item_assistant_1", transcript: "I remember your dog-friendly requirement." });
    await providerEvent({
      type: "response.done",
      response: { usage: { input_tokens: 20, output_tokens: 10, input_token_details: { cached_tokens: 5 } } },
    });
    await vi.waitFor(async () => expect((await session.snapshot()).pages[0]?.status).toBe("complete"));
    const persisted = await runtime.store.getPage((await session.snapshot()).pages[0]!.id);
    expect(persisted?.input.providerItemId).toBe("item_user_1");
    expect(persisted?.output?.providerItemId).toBe("item_assistant_1");
    if (persisted?.input.audio) persisted.input.audio.durationMs = 120_000;
    if (persisted) await runtime.store.savePage(persisted);
    await vi.waitFor(() => {
      expect(client.snapshot.runtime?.pages[0]?.input.providerItemId).toBe("item_user_1");
      expect(client.snapshot.runtime?.pages[0]?.output?.providerItemId).toBe("item_assistant_1");
    });

    await client.sendText("Now find one near a park");
    expect(client.snapshot.runtime?.compiledContext?.items.find((item) => item.unitId === persisted?.id)?.fidelity).not.toBe("audio");
    expect(peer.channel.sent.some((event) => event.type === "conversation.item.delete" && event.item_id === "item_user_1")).toBe(true);
    expect(peer.channel.sent.some((event) => event.type === "conversation.item.delete" && event.item_id === "item_assistant_1")).toBe(true);

    client.setMuted(true);
    expect(client.snapshot.muted).toBe(true);
    await client.disconnect();
    expect(client.snapshot.status).toBe("idle");
  });

  it("surfaces provider and token errors without leaking a server key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status: 401 })));
    const session = createLlmovoice().createSession({ userId: "u1" });
    const client = new OpenAIRealtimeClient({ tokenEndpoint: "/token", runtimeSession: session, audioElement: audio });
    await expect(client.connect()).rejects.toThrow("denied");
    expect(client.snapshot.status).toBe("error");
    expect(client.snapshot.error).toBe("denied");
  });

  it("serializes provider events so slow turn preparation cannot reorder Pages", async () => {
    const session = createLlmovoice({
      stateExtractionMode: "blocking",
      stateExtractor: {
        async extract({ text }) {
          if (text.includes("first")) await new Promise((resolve) => setTimeout(resolve, 25));
          return {};
        },
      },
    }).createSession({ userId: "ordered-user" });
    const client = new OpenAIRealtimeClient({ tokenEndpoint: "/token", runtimeSession: session, audioElement: audio });
    await client.connect();
    peer.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "first turn" });
    peer.channel.event({ type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "second turn" });
    await vi.waitFor(async () => expect((await session.snapshot()).pages).toHaveLength(2));
    expect((await session.snapshot()).pages.map((page) => page.input.transcript)).toEqual(["first turn", "second turn"]);
    await client.disconnect();
  });
});
