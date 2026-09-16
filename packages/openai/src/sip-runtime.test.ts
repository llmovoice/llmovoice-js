import { describe, expect, it, vi } from "vitest";
import { createLlmovoice } from "@llmovoice/runtime";
import type { OpenAIRealtimeIncomingCall } from "./sip";
import { OpenAISipController } from "./sip";
import type {
  OpenAISipSidebandClient,
  OpenAISipSidebandOptions,
  OpenAISipSidebandSnapshot,
} from "./sip-sideband";
import {
  OpenAISipRuntime,
  phoneNumberFromSipHeader,
  sipHeader,
} from "./sip-runtime";

function call(id = "rtc_12345678"): OpenAIRealtimeIncomingCall {
  return {
    eventId: `evt_${id}`,
    callId: id,
    createdAt: 1,
    sipHeaders: [
      { name: "From", value: "<sip:+16045550100@example.com>" },
      { name: "To", value: "sip:+16045550101@example.com" },
    ],
  };
}

function controller() {
  const accept = vi.fn(async () => undefined);
  const reject = vi.fn(async () => undefined);
  const hangup = vi.fn(async () => undefined);
  return {
    value: { accept, reject, hangup } as unknown as OpenAISipController,
    accept,
    reject,
    hangup,
  };
}

function fakeSideband(options: OpenAISipSidebandOptions, connectError?: Error) {
  const snapshot: OpenAISipSidebandSnapshot = {
    callId: options.callId,
    status: "connected",
    error: null,
    connectedAt: new Date().toISOString(),
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
  const value = {
    snapshot,
    connect: vi.fn(async () => { if (connectError) throw connectError; }),
    close: vi.fn(async () => { await options.onClose?.({ ...snapshot, status: "closed" }); }),
  };
  return value;
}

describe("OpenAISipRuntime", () => {
  it("extracts phone identity from case-insensitive SIP headers", () => {
    const incoming = call();
    expect(phoneNumberFromSipHeader(sipHeader(incoming, "from"))).toBe("+16045550100");
    expect(phoneNumberFromSipHeader(sipHeader(incoming, "TO"))).toBe("+16045550101");
    expect(phoneNumberFromSipHeader("anonymous")).toBeUndefined();
  });

  it("accepts an authorized call, tracks it, and hangs it up", async () => {
    const control = controller();
    let sideband: ReturnType<typeof fakeSideband> | undefined;
    const onCallStarted = vi.fn();
    const onCallEnded = vi.fn();
    const runtime = new OpenAISipRuntime({
      apiKey: "sk-test",
      controller: control.value,
      resolveCall: async () => ({
        session: createLlmovoice().createSession({ userId: "phone-user" }),
        accept: { instructions: "Answer." },
        maxDurationMs: 60_000,
        maxTotalTokens: 5_000,
      }),
      createSideband: (options) => {
        sideband = fakeSideband(options);
        return sideband as unknown as OpenAISipSidebandClient;
      },
      onCallStarted,
      onCallEnded,
    });
    const client = await runtime.handleIncomingCall(call());
    expect(client).toBe(sideband);
    expect(control.accept).toHaveBeenCalledWith("rtc_12345678", { instructions: "Answer." });
    expect(sideband?.connect).toHaveBeenCalledOnce();
    expect(runtime.activeCallCount).toBe(1);
    expect(runtime.getCall("rtc_12345678")).toBe(client);
    expect(onCallStarted).toHaveBeenCalledOnce();

    await runtime.hangup("rtc_12345678", "test-ended");
    expect(control.hangup).toHaveBeenCalledWith("rtc_12345678");
    expect(sideband?.close).toHaveBeenCalledWith("test-ended");
    expect(runtime.activeCallCount).toBe(0);
    expect(onCallEnded).toHaveBeenCalledOnce();
  });

  it("rejects unauthorized and over-capacity calls", async () => {
    const deniedControl = controller();
    const denied = new OpenAISipRuntime({
      apiKey: "sk-test",
      controller: deniedControl.value,
      resolveCall: () => null,
    });
    await expect(denied.handleIncomingCall(call())).resolves.toBeNull();
    expect(deniedControl.reject).toHaveBeenCalledWith("rtc_12345678", 603);

    const capacityControl = controller();
    const capacity = new OpenAISipRuntime({
      apiKey: "sk-test",
      controller: capacityControl.value,
      maxConcurrentCalls: 1,
      resolveCall: () => ({
        session: createLlmovoice().createSession({ userId: "u1" }),
        accept: { instructions: "Answer." },
      }),
      createSideband: (options) => fakeSideband(options) as unknown as OpenAISipSidebandClient,
    });
    await capacity.handleIncomingCall(call("rtc_first123"));
    await expect(capacity.handleIncomingCall(call("rtc_second12"))).resolves.toBeNull();
    expect(capacityControl.reject).toHaveBeenCalledWith("rtc_second12", 486);
    await capacity.shutdown();
    expect(capacity.activeCallCount).toBe(0);
  });

  it("cleans up when sideband setup fails", async () => {
    const control = controller();
    const onCallError = vi.fn();
    const runtime = new OpenAISipRuntime({
      apiKey: "sk-test",
      controller: control.value,
      resolveCall: () => ({
        session: createLlmovoice().createSession({ userId: "u1" }),
        accept: { instructions: "Answer." },
      }),
      createSideband: (options) => fakeSideband(options, new Error("socket failed")) as unknown as OpenAISipSidebandClient,
      onCallError,
    });
    await expect(runtime.handleIncomingCall(call())).rejects.toThrow("socket failed");
    expect(control.hangup).toHaveBeenCalled();
    expect(onCallError).toHaveBeenCalled();
    expect(runtime.activeCallCount).toBe(0);
  });
});
