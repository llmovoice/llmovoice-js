import type { LlmovoiceSession, PreparedTurn } from "@llmovoice/runtime";
import { TwilioRestClient, type TwilioMessageResult } from "./client";
import {
  escapeXml,
  twilioWebhookErrorResponse,
  verifyTwilioWebhook,
  xmlResponse,
  type TwilioWebhookIdempotency,
  type TwilioWebhookVerificationOptions,
} from "./webhook";

export interface TwilioInboundMessage {
  messageSid: string;
  accountSid: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  raw: Record<string, string>;
}

export interface TwilioMessageStatus {
  messageSid: string;
  accountSid: string;
  status: string;
  errorCode?: string;
  to?: string;
  from?: string;
  raw: Record<string, string>;
}

export interface TwilioSmsRuntimeResolution {
  session: LlmovoiceSession;
}

export type TwilioSmsDelivery =
  | { mode?: "twiml" }
  | {
      mode: "rest";
      client: TwilioRestClient;
      from?: string;
      messagingServiceSid?: string;
      statusCallback?: string;
    };

export interface TwilioSmsRuntimeHandlerOptions extends TwilioWebhookVerificationOptions {
  accountSid?: string;
  resolveMessage(
    message: TwilioInboundMessage,
  ): TwilioSmsRuntimeResolution | null | Promise<TwilioSmsRuntimeResolution | null>;
  respond(input: {
    message: TwilioInboundMessage;
    prepared: PreparedTurn;
    session: LlmovoiceSession;
  }): string | Promise<string>;
  delivery?: TwilioSmsDelivery;
  idempotency?: TwilioWebhookIdempotency;
  maxReplyCharacters?: number;
  optOutKeywords?: string[];
  onOptOut?: (message: TwilioInboundMessage) => void | Promise<void>;
  onRejected?: (message: TwilioInboundMessage) => void | Promise<void>;
  onDelivered?: (
    message: TwilioInboundMessage,
    result: TwilioMessageResult | null,
  ) => void | Promise<void>;
  onError?: (message: TwilioInboundMessage | null, error: unknown) => void | Promise<void>;
}

export interface TwilioMessageStatusHandlerOptions extends TwilioWebhookVerificationOptions {
  accountSid?: string;
  idempotency?: TwilioWebhookIdempotency;
  onStatus(status: TwilioMessageStatus): void | Promise<void>;
}

const DEFAULT_OPT_OUT = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Twilio webhook is missing ${name}.`);
  return value.trim();
}

export function parseTwilioInboundMessage(params: Record<string, string>): TwilioInboundMessage {
  const messageSid = required(params.MessageSid ?? params.SmsSid, "MessageSid");
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(messageSid)) throw new Error("Invalid Twilio Message SID.");
  return {
    messageSid,
    accountSid: required(params.AccountSid, "AccountSid"),
    from: required(params.From, "From"),
    to: required(params.To, "To"),
    body: params.Body ?? "",
    numMedia: Math.max(0, Number(params.NumMedia ?? 0) || 0),
    raw: { ...params },
  };
}

export function parseTwilioMessageStatus(params: Record<string, string>): TwilioMessageStatus {
  const messageSid = required(params.MessageSid ?? params.SmsSid, "MessageSid");
  if (!/^(SM|MM)[0-9a-f]{32}$/i.test(messageSid)) throw new Error("Invalid Twilio Message SID.");
  return {
    messageSid,
    accountSid: required(params.AccountSid, "AccountSid"),
    status: required(params.MessageStatus ?? params.SmsStatus, "MessageStatus"),
    ...(params.ErrorCode ? { errorCode: params.ErrorCode } : {}),
    ...(params.To ? { to: params.To } : {}),
    ...(params.From ? { from: params.From } : {}),
    raw: { ...params },
  };
}

export function createTwilioSmsRuntimeHandler(options: TwilioSmsRuntimeHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    let message: TwilioInboundMessage | null = null;
    let idempotencyKey: string | null = null;
    try {
      const { params } = await verifyTwilioWebhook(request, options);
      message = parseTwilioInboundMessage(params);
      if (options.accountSid && message.accountSid !== options.accountSid) {
        return new Response("Twilio account mismatch", { status: 403 });
      }
      idempotencyKey = `sms:${message.messageSid}`;
      if (options.idempotency && !await options.idempotency.claim(idempotencyKey)) {
        return xmlResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
      }

      const normalizedBody = message.body.trim().toUpperCase();
      const optOutKeywords = new Set((options.optOutKeywords ?? DEFAULT_OPT_OUT).map((value) => value.trim().toUpperCase()));
      if (optOutKeywords.has(normalizedBody)) {
        await options.onOptOut?.(message);
        await options.idempotency?.complete?.(idempotencyKey);
        return xmlResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
      }

      const resolution = await options.resolveMessage(message);
      if (!resolution) {
        await options.onRejected?.(message);
        await options.idempotency?.complete?.(idempotencyKey);
        return xmlResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>");
      }
      const prepared = await resolution.session.prepareSmsTurn(message.body, {
        providerItemId: message.messageSid,
      });
      const reply = (await options.respond({ message, prepared, session: resolution.session })).trim();
      const maxReplyCharacters = Math.max(1, Math.min(10_000, options.maxReplyCharacters ?? 1_600));
      if (!reply) throw new Error("The SMS responder returned an empty message.");
      if ([...reply].length > maxReplyCharacters) {
        throw new Error(`The SMS reply exceeds ${maxReplyCharacters} characters.`);
      }

      const delivery = options.delivery ?? { mode: "twiml" as const };
      let result: TwilioMessageResult | null = null;
      if (delivery.mode === "rest") {
        result = await delivery.client.sendMessage({
          to: message.from,
          body: reply,
          ...(delivery.from ? { from: delivery.from } : { from: message.to }),
          ...(delivery.messagingServiceSid ? { messagingServiceSid: delivery.messagingServiceSid } : {}),
          ...(delivery.statusCallback ? { statusCallback: delivery.statusCallback } : {}),
          maxCharacters: maxReplyCharacters,
        });
      }
      await resolution.session.ingest({
        type: "assistant.transcript.completed",
        text: reply,
        at: new Date().toISOString(),
        ...(result ? { providerItemId: result.sid } : {}),
      });
      await options.onDelivered?.(message, result);
      await options.idempotency?.complete?.(idempotencyKey);

      return delivery.mode === "rest"
        ? xmlResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>")
        : xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
    } catch (error) {
      if (idempotencyKey) await options.idempotency?.release?.(idempotencyKey, error);
      await options.onError?.(message, error);
      return twilioWebhookErrorResponse(error);
    }
  };
}

export function createTwilioMessageStatusHandler(options: TwilioMessageStatusHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    let key: string | null = null;
    try {
      const { params } = await verifyTwilioWebhook(request, options);
      const status = parseTwilioMessageStatus(params);
      if (options.accountSid && status.accountSid !== options.accountSid) {
        return new Response("Twilio account mismatch", { status: 403 });
      }
      key = `sms-status:${status.messageSid}:${status.status}`;
      if (options.idempotency && !await options.idempotency.claim(key)) return new Response(null, { status: 204 });
      await options.onStatus(status);
      await options.idempotency?.complete?.(key);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (key) await options.idempotency?.release?.(key, error);
      return twilioWebhookErrorResponse(error);
    }
  };
}
