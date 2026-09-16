import { describe, expect, it, vi } from "vitest";
import { createLlmovoice } from "@llmovoice/runtime";
import {
  computeTwilioSignature,
  createOpenAISipTwiML,
  createTwilioMessageStatusHandler,
  createTwilioSmsRuntimeHandler,
  createTwilioVoiceSipHandler,
  createTwilioVoiceStatusHandler,
  MemoryTwilioWebhookIdempotency,
  openAISipUri,
  TwilioRestClient,
  verifyTwilioWebhook,
} from "./index";

const accountSid = `AC${"a".repeat(32)}`;
const messageSid = `SM${"b".repeat(32)}`;
const callSid = `CA${"c".repeat(32)}`;
const authToken = "twilio-test-token";

function signedRequest(url: string, params: Record<string, string>, signature = computeTwilioSignature(authToken, url, params)): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(params),
  });
}

describe("Twilio webhook security and SIP routing", () => {
  it("verifies the full public URL and rejects bad signatures", async () => {
    const url = "https://voice.example.com/twilio/sms?tenant=one";
    const params = { MessageSid: messageSid, Body: "hello" };
    await expect(verifyTwilioWebhook(signedRequest(url, params), { authToken, publicUrl: url })).resolves.toMatchObject({ params });
    await expect(verifyTwilioWebhook(signedRequest(url, params, "bad"), { authToken, publicUrl: url })).rejects.toMatchObject({ status: 403 });
  });

  it("creates a bounded TLS SIP route and validates inbound calls", async () => {
    const projectId = "proj_abcdef123456";
    expect(openAISipUri(projectId)).toBe(`sip:${projectId}@sip.api.openai.com;transport=tls`);
    expect(createOpenAISipTwiML({ projectId, maxDurationSeconds: 300 })).toContain('timeLimit="300"');
    const url = "https://voice.example.com/twilio/voice";
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: "+16045550100",
      To: "+16045550101",
      CallStatus: "ringing",
    };
    const authorizeCall = vi.fn(async () => true);
    const handler = createTwilioVoiceSipHandler({
      authToken,
      publicUrl: url,
      accountSid,
      openAIProjectId: projectId,
      maxDurationSeconds: 600,
      authorizeCall,
    });
    const response = await handler(signedRequest(url, params));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`sip:${projectId}@sip.api.openai.com;transport=tls`);
    expect(authorizeCall).toHaveBeenCalledWith(expect.objectContaining({ callSid, from: "+16045550100" }));
  });

  it("rejects blocked calls and reports terminal voice statuses once", async () => {
    const voiceUrl = "https://voice.example.com/twilio/voice";
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: "+16045550100",
      To: "+16045550101",
      CallStatus: "completed",
      CallDuration: "42",
    };
    const rejected = await createTwilioVoiceSipHandler({
      authToken,
      publicUrl: voiceUrl,
      openAIProjectId: "proj_abcdef123456",
      authorizeCall: () => false,
    })(signedRequest(voiceUrl, params));
    expect(await rejected.text()).toContain("<Reject");

    const statusUrl = "https://voice.example.com/twilio/call-status";
    const onStatus = vi.fn();
    const idempotency = new MemoryTwilioWebhookIdempotency();
    const handler = createTwilioVoiceStatusHandler({ authToken, publicUrl: statusUrl, idempotency, onStatus });
    expect((await handler(signedRequest(statusUrl, params))).status).toBe(204);
    expect((await handler(signedRequest(statusUrl, params))).status).toBe(204);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: 42, status: "completed" }));
  });

  it("routes duplicate voice webhooks idempotently and blocks account mismatches", async () => {
    const url = "https://voice.example.com/twilio/voice";
    const params = {
      AccountSid: accountSid,
      CallSid: `CA${"9".repeat(32)}`,
      From: "+16045550100",
      To: "+16045550101",
    };
    const onRouted = vi.fn();
    const handler = createTwilioVoiceSipHandler({
      authToken,
      publicUrl: url,
      accountSid,
      openAIProjectId: "proj_abcdef123456",
      idempotency: new MemoryTwilioWebhookIdempotency(),
      onRouted,
    });
    expect((await handler(signedRequest(url, params))).status).toBe(200);
    expect((await handler(signedRequest(url, params))).status).toBe(200);
    expect(onRouted).toHaveBeenCalledTimes(1);

    const mismatch = createTwilioVoiceSipHandler({
      authToken,
      publicUrl: url,
      accountSid: `AC${"0".repeat(32)}`,
      openAIProjectId: "proj_abcdef123456",
    });
    expect((await mismatch(signedRequest(url, params))).status).toBe(403);
  });
});

describe("Twilio SMS runtime", () => {
  it("routes an inbound SMS through Page, Thread, compiler, and TwiML reply", async () => {
    const runtime = createLlmovoice();
    const session = runtime.createSession({ userId: "sms-user", sessionId: "sms-session" });
    const url = "https://voice.example.com/twilio/sms";
    const params = {
      AccountSid: accountSid,
      MessageSid: messageSid,
      From: "+16045550100",
      To: "+16045550101",
      Body: "Continue my hotel search",
      NumMedia: "0",
    };
    const handler = createTwilioSmsRuntimeHandler({
      authToken,
      publicUrl: url,
      accountSid,
      idempotency: new MemoryTwilioWebhookIdempotency(),
      resolveMessage: async () => ({ session }),
      respond: async ({ prepared }) => `Thread: ${prepared.routing.threads[0]?.id ?? "new"}`,
    });
    const response = await handler(signedRequest(url, params));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("&lt;");
    const snapshot = await session.snapshot();
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.pages[0]?.input.modality).toBe("sms");
    expect(snapshot.pages[0]?.output?.modality).toBe("sms");
    expect(snapshot.pages[0]?.status).toBe("complete");

    const duplicate = await handler(signedRequest(url, params));
    expect(await duplicate.text()).toContain("<Response/>");
    expect((await session.snapshot()).pages).toHaveLength(1);
  });

  it("honors standard opt-out keywords without invoking the model", async () => {
    const url = "https://voice.example.com/twilio/sms";
    const params = {
      AccountSid: accountSid,
      MessageSid: `SM${"d".repeat(32)}`,
      From: "+16045550100",
      To: "+16045550101",
      Body: "STOP",
    };
    const resolveMessage = vi.fn();
    const onOptOut = vi.fn();
    const handler = createTwilioSmsRuntimeHandler({ authToken, publicUrl: url, resolveMessage, respond: vi.fn(), onOptOut });
    expect((await handler(signedRequest(url, params))).status).toBe(200);
    expect(onOptOut).toHaveBeenCalledOnce();
    expect(resolveMessage).not.toHaveBeenCalled();
  });

  it("delivers REST replies and consumes delivery status callbacks idempotently", async () => {
    const inboundUrl = "https://voice.example.com/twilio/sms";
    const statusUrl = "https://voice.example.com/twilio/message-status";
    const outboundSid = `SM${"e".repeat(32)}`;
    const fetchMock = vi.fn(async () => Response.json({
      sid: outboundSid,
      status: "queued",
      to: "+16045550100",
      from: "+16045550101",
      body: "REST reply",
    }));
    const client = new TwilioRestClient({ accountSid, authToken, defaultFrom: "+16045550101", fetch: fetchMock });
    const session = createLlmovoice().createSession({ userId: "rest-sms-user" });
    const inbound = {
      AccountSid: accountSid,
      MessageSid: `SM${"f".repeat(32)}`,
      From: "+16045550100",
      To: "+16045550101",
      Body: "hello",
    };
    const response = await createTwilioSmsRuntimeHandler({
      authToken,
      publicUrl: inboundUrl,
      resolveMessage: () => ({ session }),
      respond: () => "REST reply",
      delivery: { mode: "rest", client, statusCallback: statusUrl },
    })(signedRequest(inboundUrl, inbound));
    expect(await response.text()).toContain("<Response/>");
    expect((await session.snapshot()).pages[0]?.output?.providerItemId).toBe(outboundSid);

    const onStatus = vi.fn();
    const idempotency = new MemoryTwilioWebhookIdempotency();
    const statusHandler = createTwilioMessageStatusHandler({ authToken, publicUrl: statusUrl, idempotency, onStatus });
    const statusParams = {
      AccountSid: accountSid,
      MessageSid: outboundSid,
      MessageStatus: "delivered",
      To: "+16045550100",
      From: "+16045550101",
      ErrorCode: "30007",
    };
    expect((await statusHandler(signedRequest(statusUrl, statusParams))).status).toBe(204);
    expect((await statusHandler(signedRequest(statusUrl, statusParams))).status).toBe(204);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "30007" }));
  });
});

describe("Twilio REST transport", () => {
  it("sends outbound SMS and bridges outbound calls to OpenAI SIP", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      if (String(_url).endsWith("Messages.json")) {
        expect(body.get("Body")).toBe("hello");
        return Response.json({ sid: messageSid, status: "queued", to: body.get("To"), from: body.get("From"), body: body.get("Body") });
      }
      expect(body.get("Twiml")).toContain("sip:proj_abcdef123456@sip.api.openai.com;transport=tls");
      expect(body.get("TimeLimit")).toBe("120");
      return Response.json({ sid: callSid, status: "queued", to: body.get("To"), from: body.get("From") });
    });
    const client = new TwilioRestClient({ accountSid, authToken, defaultFrom: "+16045550101", fetch: fetchMock });
    await expect(client.sendMessage({ to: "+16045550100", body: "hello" })).resolves.toMatchObject({ sid: messageSid });
    await expect(client.createCall({ to: "+16045550100", openAIProjectId: "proj_abcdef123456", maxDurationSeconds: 120 })).resolves.toMatchObject({ sid: callSid });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hangs up calls and surfaces provider and input errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ sid: callSid, status: "completed" }))
      .mockResolvedValueOnce(Response.json({ message: "carrier rejected" }, { status: 400 }));
    const client = new TwilioRestClient({ accountSid, authToken, defaultFrom: "+16045550101", fetch: fetchMock });
    await expect(client.hangupCall(callSid)).resolves.toBeUndefined();
    await expect(client.sendMessage({ to: "+16045550100", body: "hello" })).rejects.toThrow("carrier rejected");
    await expect(client.sendMessage({ to: "+16045550100", body: "too long", maxCharacters: 2 })).rejects.toThrow("exceeds");
    await expect(client.sendMessage({ to: "+16045550100", body: "   " })).rejects.toThrow("empty");
    await expect(client.hangupCall("bad-call")).rejects.toThrow("Invalid Twilio CA SID");
    expect(() => openAISipUri("bad-project")).toThrow("project ID");
  });

  it("supports Messaging Services, callbacks, and outbound call options", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      if (String(url).endsWith("Messages.json")) {
        expect(body.get("MessagingServiceSid")).toBe(`MG${"a".repeat(32)}`);
        expect(body.get("From")).toBeNull();
        expect(body.get("StatusCallback")).toBe("https://voice.example.com/status");
        return Response.json({ sid: messageSid, status: "queued", body: "hello" });
      }
      expect(body.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
      expect(body.get("Twiml")).toContain('answerOnBridge="false"');
      return Response.json({ sid: callSid });
    });
    const client = new TwilioRestClient({
      accountSid,
      authToken,
      messagingServiceSid: `MG${"a".repeat(32)}`,
      defaultFrom: "+16045550101",
      fetch: fetchMock,
    });
    await client.sendMessage({ to: "+16045550100", body: "hello", statusCallback: "https://voice.example.com/status" });
    await client.createCall({
      to: "+16045550100",
      from: "+16045550102",
      openAIProjectId: "proj_abcdef123456",
      answerOnBridge: false,
      statusCallback: "https://voice.example.com/call-status",
      sipStatusCallback: "https://voice.example.com/sip-status",
    });
    expect(() => new TwilioRestClient({ accountSid: "bad", authToken })).toThrow("Account SID");
    expect(() => new TwilioRestClient({ accountSid, authToken: "" })).toThrow("Auth Token");
    const noSender = new TwilioRestClient({ accountSid, authToken, fetch: fetchMock });
    await expect(noSender.sendMessage({ to: "+16045550100", body: "hello" })).rejects.toThrow("From number");
  });
});

describe("Twilio webhook guard rails", () => {
  it("requires POST form webhooks and supports releasing local idempotency claims", async () => {
    const url = "https://voice.example.com/twilio/sms";
    await expect(verifyTwilioWebhook(new Request(url), { authToken, publicUrl: url })).rejects.toMatchObject({ status: 405 });
    await expect(verifyTwilioWebhook(new Request(url, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), { authToken, publicUrl: url })).rejects.toMatchObject({ status: 415 });
    const idempotency = new MemoryTwilioWebhookIdempotency(60_000, 2);
    expect(idempotency.claim("one")).toBe(true);
    expect(idempotency.claim("one")).toBe(false);
    idempotency.release("one");
    expect(idempotency.claim("one")).toBe(true);
  });

  it("bounds bodies and requires an exact secure public URL and signature", async () => {
    const url = "https://voice.example.com/twilio/sms";
    const params = { MessageSid: messageSid };
    const declaredLarge = signedRequest(url, params);
    declaredLarge.headers.set("Content-Length", "9999");
    await expect(verifyTwilioWebhook(declaredLarge, { authToken, publicUrl: url, maxBodyBytes: 1024 })).rejects.toMatchObject({ status: 413 });
    await expect(verifyTwilioWebhook(signedRequest(url, params), { authToken, publicUrl: "not a url" })).rejects.toMatchObject({ status: 500 });
    await expect(verifyTwilioWebhook(signedRequest(url, params), { authToken, publicUrl: "http://voice.example.com/twilio/sms" })).rejects.toMatchObject({ status: 500 });
    await expect(verifyTwilioWebhook(signedRequest(url, params), { authToken: "", publicUrl: url })).rejects.toMatchObject({ status: 500 });
    const noSignature = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    await expect(verifyTwilioWebhook(noSignature, { authToken, publicUrl: (request) => request.url })).rejects.toMatchObject({ status: 403 });
  });

  it("releases failed SMS claims and rejects unknown users without a model call", async () => {
    const url = "https://voice.example.com/twilio/sms";
    const params = {
      AccountSid: accountSid,
      MessageSid: `SM${"1".repeat(32)}`,
      From: "+16045550100",
      To: "+16045550101",
      Body: "hello",
    };
    const onRejected = vi.fn();
    const rejected = createTwilioSmsRuntimeHandler({
      authToken,
      publicUrl: url,
      resolveMessage: () => null,
      respond: vi.fn(),
      onRejected,
    });
    expect((await rejected(signedRequest(url, params))).status).toBe(200);
    expect(onRejected).toHaveBeenCalledOnce();

    const idempotency = {
      claim: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const onError = vi.fn();
    const session = createLlmovoice().createSession({ userId: "u1" });
    const failed = createTwilioSmsRuntimeHandler({
      authToken,
      publicUrl: url,
      idempotency,
      resolveMessage: () => ({ session }),
      respond: () => "",
      onError,
    });
    expect((await failed(signedRequest(url, params))).status).toBe(500);
    expect(idempotency.release).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
