export interface TwilioRestClientOptions {
  accountSid: string;
  authToken: string;
  defaultFrom?: string;
  messagingServiceSid?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SendTwilioMessageOptions {
  to: string;
  body: string;
  from?: string;
  messagingServiceSid?: string;
  statusCallback?: string;
  maxCharacters?: number;
}

export interface TwilioMessageResult {
  sid: string;
  status: string;
  to: string;
  from?: string;
  body: string;
  raw: Record<string, unknown>;
}

export interface CreateTwilioCallOptions {
  to: string;
  from?: string;
  openAIProjectId: string;
  statusCallback?: string;
  sipStatusCallback?: string;
  maxDurationSeconds?: number;
  answerOnBridge?: boolean;
}

export interface TwilioCallResult {
  sid: string;
  status: string;
  to: string;
  from?: string;
  raw: Record<string, unknown>;
}

function accountSid(value: string): string {
  if (!/^AC[0-9a-f]{32}$/i.test(value)) throw new Error("Invalid Twilio Account SID.");
  return value;
}

function resourceSid(value: string, prefix: "CA" | "SM" | "MM"): string {
  if (!new RegExp(`^${prefix}[0-9a-f]{32}$`, "i").test(value)) throw new Error(`Invalid Twilio ${prefix} SID.`);
  return value;
}

function destination(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) throw new Error("Invalid Twilio destination.");
  return trimmed;
}

export function openAISipUri(projectId: string): string {
  const normalized = projectId.trim();
  if (!/^proj_[a-zA-Z0-9_-]{6,120}$/.test(normalized)) throw new Error("Invalid OpenAI project ID.");
  return `sip:${normalized}@sip.api.openai.com;transport=tls`;
}

export function createOpenAISipTwiML(input: {
  projectId: string;
  maxDurationSeconds?: number;
  answerOnBridge?: boolean;
  statusCallback?: string;
}): string {
  const duration = Math.max(1, Math.min(86_400, Math.floor(input.maxDurationSeconds ?? 3_600)));
  const dialAttributes = [
    `answerOnBridge="${input.answerOnBridge === false ? "false" : "true"}"`,
    `timeLimit="${duration}"`,
  ].join(" ");
  const sipAttributes = input.statusCallback
    ? ` statusCallback="${escapeAttribute(input.statusCallback)}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed"`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${dialAttributes}><Sip${sipAttributes}>${openAISipUri(input.projectId)}</Sip></Dial></Response>`;
}

function escapeAttribute(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Twilio callback URLs must use HTTPS.");
  return url.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export class TwilioRestClient {
  private readonly account: string;

  constructor(private readonly options: TwilioRestClientOptions) {
    this.account = accountSid(options.accountSid);
    if (!options.authToken.trim()) throw new Error("A Twilio Auth Token is required.");
  }

  async sendMessage(input: SendTwilioMessageOptions): Promise<TwilioMessageResult> {
    const body = input.body.trim();
    const maxCharacters = Math.max(1, Math.min(10_000, input.maxCharacters ?? 1_600));
    if (!body) throw new Error("SMS body cannot be empty.");
    if ([...body].length > maxCharacters) throw new Error(`SMS body exceeds ${maxCharacters} characters.`);
    const from = input.from ?? this.options.defaultFrom;
    const messagingServiceSid = input.messagingServiceSid ?? this.options.messagingServiceSid;
    if (!from && !messagingServiceSid) throw new Error("Twilio SMS requires a From number or Messaging Service SID.");
    const params = new URLSearchParams({ To: destination(input.to), Body: body });
    if (messagingServiceSid) params.set("MessagingServiceSid", messagingServiceSid);
    else params.set("From", destination(from!));
    if (input.statusCallback) params.set("StatusCallback", this.callbackUrl(input.statusCallback));
    const raw = await this.request(`Messages.json`, params);
    const sid = typeof raw.sid === "string" ? raw.sid : "";
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(sid)) throw new Error("Twilio did not return a valid Message SID.");
    return {
      sid,
      status: typeof raw.status === "string" ? raw.status : "unknown",
      to: typeof raw.to === "string" ? raw.to : input.to,
      ...(typeof raw.from === "string" ? { from: raw.from } : {}),
      body: typeof raw.body === "string" ? raw.body : body,
      raw,
    };
  }

  async createCall(input: CreateTwilioCallOptions): Promise<TwilioCallResult> {
    const from = input.from ?? this.options.defaultFrom;
    if (!from) throw new Error("Twilio Voice requires a From number.");
    const maxDurationSeconds = Math.max(1, Math.min(86_400, Math.floor(input.maxDurationSeconds ?? 3_600)));
    const params = new URLSearchParams({
      To: destination(input.to),
      From: destination(from),
      Twiml: createOpenAISipTwiML({
        projectId: input.openAIProjectId,
        maxDurationSeconds,
        ...(input.answerOnBridge !== undefined ? { answerOnBridge: input.answerOnBridge } : {}),
        ...(input.sipStatusCallback ? { statusCallback: input.sipStatusCallback } : {}),
      }),
      TimeLimit: String(maxDurationSeconds),
    });
    if (input.statusCallback) {
      params.set("StatusCallback", this.callbackUrl(input.statusCallback));
      for (const event of ["initiated", "ringing", "answered", "completed"]) params.append("StatusCallbackEvent", event);
    }
    const raw = await this.request("Calls.json", params);
    const sid = typeof raw.sid === "string" ? raw.sid : "";
    resourceSid(sid, "CA");
    return {
      sid,
      status: typeof raw.status === "string" ? raw.status : "unknown",
      to: typeof raw.to === "string" ? raw.to : input.to,
      ...(typeof raw.from === "string" ? { from: raw.from } : {}),
      raw,
    };
  }

  async hangupCall(callSid: string): Promise<void> {
    await this.request(`Calls/${resourceSid(callSid, "CA")}.json`, new URLSearchParams({ Status: "completed" }));
  }

  private callbackUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("Twilio callback URLs must use HTTPS.");
    return url.toString();
  }

  private async request(resource: string, body: URLSearchParams): Promise<Record<string, unknown>> {
    const base = this.options.apiBaseUrl ?? "https://api.twilio.com/2010-04-01";
    const response = await (this.options.fetch ?? fetch)(`${base}/Accounts/${this.account}/${resource}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.account}:${this.options.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
      signal: AbortSignal.timeout(Math.max(1_000, this.options.timeoutMs ?? 8_000)),
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown> & { message?: unknown };
    if (!response.ok) {
      throw new Error(typeof data.message === "string" ? data.message : `Twilio request failed (${response.status}).`);
    }
    return data;
  }
}
