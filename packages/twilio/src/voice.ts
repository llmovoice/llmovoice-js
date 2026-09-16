import { createOpenAISipTwiML } from "./client";
import {
  twilioWebhookErrorResponse,
  verifyTwilioWebhook,
  xmlResponse,
  type TwilioWebhookIdempotency,
  type TwilioWebhookVerificationOptions,
} from "./webhook";

export interface TwilioVoiceEvent {
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  status: string;
  direction?: string;
  callerCountry?: string;
  calledCountry?: string;
  durationSeconds?: number;
  raw: Record<string, string>;
}

export interface TwilioVoiceSipHandlerOptions extends TwilioWebhookVerificationOptions {
  accountSid?: string;
  openAIProjectId: string;
  authorizeCall?: (event: TwilioVoiceEvent) => boolean | Promise<boolean>;
  idempotency?: TwilioWebhookIdempotency;
  maxDurationSeconds?: number;
  sipStatusCallback?: string;
  onRouted?: (event: TwilioVoiceEvent) => void | Promise<void>;
  onRejected?: (event: TwilioVoiceEvent) => void | Promise<void>;
  onError?: (event: TwilioVoiceEvent | null, error: unknown) => void | Promise<void>;
}

export interface TwilioVoiceStatusHandlerOptions extends TwilioWebhookVerificationOptions {
  accountSid?: string;
  idempotency?: TwilioWebhookIdempotency;
  onStatus(event: TwilioVoiceEvent): void | Promise<void>;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Twilio webhook is missing ${name}.`);
  return value.trim();
}

export function parseTwilioVoiceEvent(params: Record<string, string>): TwilioVoiceEvent {
  const callSid = required(params.CallSid, "CallSid");
  if (!/^CA[0-9a-f]{32}$/i.test(callSid)) throw new Error("Invalid Twilio Call SID.");
  const duration = Number(params.CallDuration ?? params.Duration ?? Number.NaN);
  return {
    callSid,
    accountSid: required(params.AccountSid, "AccountSid"),
    from: required(params.From ?? params.Caller, "From"),
    to: required(params.To ?? params.Called, "To"),
    status: params.CallStatus?.trim() || "incoming",
    ...(params.Direction ? { direction: params.Direction } : {}),
    ...(params.CallerCountry ? { callerCountry: params.CallerCountry } : {}),
    ...(params.CalledCountry ? { calledCountry: params.CalledCountry } : {}),
    ...(Number.isFinite(duration) ? { durationSeconds: Math.max(0, duration) } : {}),
    raw: { ...params },
  };
}

export function createTwilioVoiceSipHandler(options: TwilioVoiceSipHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    let event: TwilioVoiceEvent | null = null;
    let key: string | null = null;
    try {
      const { params } = await verifyTwilioWebhook(request, options);
      event = parseTwilioVoiceEvent(params);
      if (options.accountSid && event.accountSid !== options.accountSid) {
        return new Response("Twilio account mismatch", { status: 403 });
      }
      key = `voice-route:${event.callSid}`;
      if (options.idempotency && !await options.idempotency.claim(key)) {
        return xmlResponse(createOpenAISipTwiML({
          projectId: options.openAIProjectId,
          maxDurationSeconds: options.maxDurationSeconds ?? 3_600,
          ...(options.sipStatusCallback ? { statusCallback: options.sipStatusCallback } : {}),
        }));
      }
      const allowed = await options.authorizeCall?.(event) ?? true;
      if (!allowed) {
        await options.onRejected?.(event);
        await options.idempotency?.complete?.(key);
        return xmlResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"rejected\"/></Response>");
      }
      await options.onRouted?.(event);
      await options.idempotency?.complete?.(key);
      return xmlResponse(createOpenAISipTwiML({
        projectId: options.openAIProjectId,
        maxDurationSeconds: options.maxDurationSeconds ?? 3_600,
        ...(options.sipStatusCallback ? { statusCallback: options.sipStatusCallback } : {}),
      }));
    } catch (error) {
      if (key) await options.idempotency?.release?.(key, error);
      await options.onError?.(event, error);
      return twilioWebhookErrorResponse(error);
    }
  };
}

export function createTwilioVoiceStatusHandler(options: TwilioVoiceStatusHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    let key: string | null = null;
    try {
      const { params } = await verifyTwilioWebhook(request, options);
      const event = parseTwilioVoiceEvent(params);
      if (options.accountSid && event.accountSid !== options.accountSid) {
        return new Response("Twilio account mismatch", { status: 403 });
      }
      key = `voice-status:${event.callSid}:${event.status}`;
      if (options.idempotency && !await options.idempotency.claim(key)) return new Response(null, { status: 204 });
      await options.onStatus(event);
      await options.idempotency?.complete?.(key);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (key) await options.idempotency?.release?.(key, error);
      return twilioWebhookErrorResponse(error);
    }
  };
}
