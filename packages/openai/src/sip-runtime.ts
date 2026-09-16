import type { DirectiveExecutor } from "@llmovoice/core";
import type { LlmovoiceSession } from "@llmovoice/runtime";
import {
  createOpenAISipWebhookHandler,
  OpenAISipController,
  type AcceptSipCallOptions,
  type OpenAIRealtimeIncomingCall,
} from "./sip";
import {
  OpenAISipSidebandClient,
  type OpenAISipSidebandOptions,
  type OpenAISipSidebandSnapshot,
  type OpenAISipToolCall,
} from "./sip-sideband";

export interface OpenAISipCallResolution {
  session: LlmovoiceSession;
  accept: AcceptSipCallOptions;
  baseInstructions?: string;
  initialResponseInstructions?: string;
  safetyIdentifier?: string;
  directiveExecutors?: DirectiveExecutor[];
  onToolCall?: (call: OpenAISipToolCall) => unknown | Promise<unknown>;
  maxDurationMs?: number;
  maxTotalTokens?: number;
}

export interface OpenAISipRuntimeOptions {
  apiKey: string;
  resolveCall(
    call: OpenAIRealtimeIncomingCall,
  ): OpenAISipCallResolution | null | Promise<OpenAISipCallResolution | null>;
  controller?: OpenAISipController;
  maxConcurrentCalls?: number;
  sideband?: Omit<
    OpenAISipSidebandOptions,
    | "apiKey"
    | "callId"
    | "runtimeSession"
    | "baseInstructions"
    | "initialResponseInstructions"
    | "safetyIdentifier"
    | "directiveExecutors"
    | "onToolCall"
    | "maxDurationMs"
    | "maxTotalTokens"
    | "onLimit"
    | "onClose"
  >;
  createSideband?: (options: OpenAISipSidebandOptions) => OpenAISipSidebandClient;
  onCallStarted?: (
    call: OpenAIRealtimeIncomingCall,
    client: OpenAISipSidebandClient,
  ) => void | Promise<void>;
  onCallEnded?: (
    call: OpenAIRealtimeIncomingCall,
    snapshot: OpenAISipSidebandSnapshot,
  ) => void | Promise<void>;
  onCallError?: (
    call: OpenAIRealtimeIncomingCall,
    error: unknown,
  ) => void | Promise<void>;
}

export interface OpenAISipRuntimeWebhookOptions {
  runtime: OpenAISipRuntime;
  verify(body: string, headers: Headers): unknown | Promise<unknown>;
  claimEvent?: (eventId: string) => boolean | Promise<boolean>;
  maxBodyBytes?: number;
}

export function sipHeader(call: OpenAIRealtimeIncomingCall, name: string): string | undefined {
  const normalized = name.trim().toLowerCase();
  return call.sipHeaders.find((header) => header.name.trim().toLowerCase() === normalized)?.value;
}

export function phoneNumberFromSipHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(?:sip:|tel:)?(\+[1-9]\d{6,14})/i);
  return match?.[1];
}

export class OpenAISipRuntime {
  readonly controller: OpenAISipController;
  private readonly active = new Map<
    string,
    { call: OpenAIRealtimeIncomingCall; client: OpenAISipSidebandClient }
  >();

  constructor(private readonly options: OpenAISipRuntimeOptions) {
    if (!options.apiKey.trim()) throw new Error("An OpenAI API key is required.");
    this.controller = options.controller ?? new OpenAISipController({ apiKey: options.apiKey });
  }

  get activeCallCount(): number {
    return this.active.size;
  }

  getCall(callId: string): OpenAISipSidebandClient | undefined {
    return this.active.get(callId)?.client;
  }

  async handleIncomingCall(call: OpenAIRealtimeIncomingCall): Promise<OpenAISipSidebandClient | null> {
    const existing = this.active.get(call.callId);
    if (existing) return existing.client;

    const maxConcurrentCalls = Math.max(1, this.options.maxConcurrentCalls ?? 100);
    if (this.active.size >= maxConcurrentCalls) {
      await this.controller.reject(call.callId, 486);
      return null;
    }

    let resolution: OpenAISipCallResolution | null;
    try {
      resolution = await this.options.resolveCall(call);
    } catch (error) {
      await this.options.onCallError?.(call, error);
      await this.controller.reject(call.callId, 500).catch(() => undefined);
      throw error;
    }
    if (!resolution) {
      await this.controller.reject(call.callId, 603);
      return null;
    }

    const createSideband = this.options.createSideband
      ?? ((input: OpenAISipSidebandOptions) => new OpenAISipSidebandClient(input));
    let client: OpenAISipSidebandClient;
    let ending = false;
    const endCall = async (reason: "duration" | "tokens") => {
      if (ending) return;
      ending = true;
      await this.controller.hangup(call.callId).catch(() => undefined);
      await client.close(`limit-${reason}`).catch(() => undefined);
    };
    client = createSideband({
      apiKey: this.options.apiKey,
      callId: call.callId,
      runtimeSession: resolution.session,
      ...(resolution.baseInstructions ? { baseInstructions: resolution.baseInstructions } : {}),
      ...(resolution.initialResponseInstructions ? { initialResponseInstructions: resolution.initialResponseInstructions } : {}),
      ...(resolution.safetyIdentifier ? { safetyIdentifier: resolution.safetyIdentifier } : {}),
      ...(resolution.directiveExecutors ? { directiveExecutors: resolution.directiveExecutors } : {}),
      ...(resolution.onToolCall ? { onToolCall: resolution.onToolCall } : {}),
      ...(resolution.maxDurationMs ? { maxDurationMs: resolution.maxDurationMs } : {}),
      ...(resolution.maxTotalTokens ? { maxTotalTokens: resolution.maxTotalTokens } : {}),
      ...this.options.sideband,
      onLimit: endCall,
      onClose: async (snapshot) => {
        const wasActive = this.active.delete(call.callId);
        if (wasActive) await this.controller.hangup(call.callId).catch(() => undefined);
        await this.options.onCallEnded?.(call, snapshot);
      },
    });
    this.active.set(call.callId, { call, client });

    try {
      await this.controller.accept(call.callId, {
        ...resolution.accept,
        ...(resolution.safetyIdentifier ? { safetyIdentifier: resolution.safetyIdentifier } : {}),
      });
      await client.connect();
      await this.options.onCallStarted?.(call, client);
      return client;
    } catch (error) {
      this.active.delete(call.callId);
      await client.close("setup-failed").catch(() => undefined);
      await this.controller.hangup(call.callId).catch(() => undefined);
      await this.options.onCallError?.(call, error);
      throw error;
    }
  }

  async hangup(callId: string, reason = "application-ended"): Promise<void> {
    const active = this.active.get(callId);
    this.active.delete(callId);
    await this.controller.hangup(callId);
    await active?.client.close(reason);
  }

  async shutdown(): Promise<void> {
    const calls = [...this.active.values()];
    this.active.clear();
    await Promise.allSettled(calls.map(async ({ call, client }) => {
      await this.controller.hangup(call.callId).catch(() => undefined);
      await client.close("runtime-shutdown").catch(() => undefined);
    }));
  }
}

export function createOpenAISipRuntimeWebhookHandler(options: OpenAISipRuntimeWebhookOptions) {
  return createOpenAISipWebhookHandler({
    controller: options.runtime.controller,
    verify: options.verify,
    onIncomingCall: (call) => options.runtime.handleIncomingCall(call).then(() => undefined),
    ...(options.claimEvent ? { claimEvent: options.claimEvent } : {}),
    ...(options.maxBodyBytes ? { maxBodyBytes: options.maxBodyBytes } : {}),
  });
}
