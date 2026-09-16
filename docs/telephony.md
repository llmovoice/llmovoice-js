# Twilio Voice, OpenAI SIP, and SMS

This guide connects a Twilio phone number to llmovoice for realtime calls and text messages. The implementation uses Twilio for PSTN/SMS transport, OpenAI Realtime SIP for speech-to-speech inference, and the same llmovoice Runtime used by browser and text applications.

## Architecture

```text
Caller
  │
  ▼
Twilio number ── TLS SIP ──► OpenAI Realtime SIP
  │                              │
  │ status webhooks              │ realtime.call.incoming
  ▼                              ▼
Application              OpenAISipRuntime
                                │
                                ├─ verify + authorize + accept
                                ├─ server-side sideband WebSocket
                                ├─ transcript → Page → Thread
                                ├─ Context Compiler → response.create
                                ├─ private tool/directive execution
                                └─ usage, limits, reconnect, hangup

SMS sender ── Twilio webhook ──► prepareSmsTurn()
                                      │
                                      ├─ Page + Thread + compiled context
                                      ├─ application text-model callback
                                      └─ TwiML reply or Twilio REST delivery
```

The sideband connection must run in a persistent Node.js process for the lifetime of the call. Do not start it in a serverless function that freezes or exits immediately after returning the webhook response.

## 1. Install

```bash
pnpm add @llmovoice/openai @llmovoice/runtime @llmovoice/twilio
```

Add a durable store such as `@llmovoice/supabase` or `@llmovoice/postgres` when calls and messages must survive process restarts.

Configure server-only credentials:

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_PROJECT_ID=proj_...
OPENAI_WEBHOOK_SECRET=whsec_...

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+16045550100
TWILIO_MESSAGING_SERVICE_SID=MG...

PUBLIC_WEBHOOK_BASE_URL=https://voice.example.com
```

Never expose the OpenAI key, OpenAI webhook secret, or Twilio Auth Token to browser code.

## 2. Route the Twilio number to OpenAI SIP

The simplest production route is Twilio Elastic SIP Trunking:

1. Create a Twilio Elastic SIP Trunk.
2. Add this origination URI, replacing the project ID:

   ```text
   sip:proj_your_project@sip.api.openai.com;transport=tls
   ```

3. Attach the Twilio phone number to the trunk.
4. In OpenAI project settings, create a webhook for `realtime.call.incoming` pointing to your application route.

Alternatively, configure the Twilio number's Programmable Voice webhook to a route using `createTwilioVoiceSipHandler()`. This lets the application verify and reject the Twilio webhook before returning SIP-routing TwiML:

```ts
import {
  MemoryTwilioWebhookIdempotency,
  createTwilioVoiceSipHandler,
} from "@llmovoice/twilio";

const voiceHandler = createTwilioVoiceSipHandler({
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  publicUrl: `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/twilio/voice`,
  openAIProjectId: process.env.OPENAI_PROJECT_ID!,
  maxDurationSeconds: 1_800,
  idempotency: new MemoryTwilioWebhookIdempotency(),
  authorizeCall: async ({ from, callerCountry }) => {
    return isAllowedCaller(from) && isSupportedCountry(callerCountry);
  },
});

export const POST = voiceHandler;
```

Use a distributed idempotency implementation in multi-instance production.

## 3. Accept the OpenAI call and start the Runtime sideband

OpenAI signs its incoming-call webhook. Keep signature verification in the host application so it can use the current official OpenAI SDK helper.

Create one long-lived `OpenAISipRuntime` per worker:

```ts
import { createHash } from "node:crypto";
import OpenAI from "openai";
import {
  OpenAISipRuntime,
  createOpenAISipRuntimeWebhookHandler,
  phoneNumberFromSipHeader,
  sipHeader,
} from "@llmovoice/openai";
import { createLlmovoice } from "@llmovoice/runtime";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET!,
});

const llmovoice = createLlmovoice({ store, sources, embedding, summary });

const sipRuntime = new OpenAISipRuntime({
  apiKey: process.env.OPENAI_API_KEY!,
  maxConcurrentCalls: 100,

  async resolveCall(call) {
    const caller = phoneNumberFromSipHeader(sipHeader(call, "From"));
    const called = phoneNumberFromSipHeader(sipHeader(call, "To"));
    const identity = await resolvePhoneIdentity({ caller, called });
    if (!identity || identity.blocked) return null;

    const session = llmovoice.createSession({
      userId: identity.userId,
      sessionId: identity.stableVoiceSessionId,
      resume: true,
    });

    return {
      session,
      safetyIdentifier: createHash("sha256").update(identity.userId).digest("hex"),
      accept: {
        model: "gpt-realtime-2.1",
        voice: "marin",
        instructions: "You are a concise phone assistant. Wait for the caller unless greeted by the application.",
        maxInputTokens: 8_000,
        maxOutputTokens: 1_024,
        tools: phoneTools,
      },
      baseInstructions: "Respond naturally in the caller's language. Respect the supplied historical constraints.",
      initialResponseInstructions: "Greet the caller briefly and ask how you can help.",
      maxDurationMs: 30 * 60_000,
      maxTotalTokens: 100_000,
      onToolCall: executePrivatePhoneTool,
      directiveExecutors: [applicationDirectiveExecutor],
    };
  },

  onCallStarted: async (call) => recordCallStarted(call.callId),
  onCallEnded: async (call, snapshot) => recordCallEnded(call.callId, snapshot),
  onCallError: async (call, error) => recordCallError(call.callId, error),
});

const openAIWebhook = createOpenAISipRuntimeWebhookHandler({
  runtime: sipRuntime,
  verify: (body, headers) => openai.webhooks.unwrap(body, headers),
  claimEvent: (eventId) => claimOpenAIWebhookInDatabase(eventId),
});

export const POST = openAIWebhook;
```

The call flow deliberately configures server VAD with `create_response: false`. When a final caller transcript arrives, the sideband client:

1. updates content/style state;
2. creates and routes a VoicePage;
3. restores or spawns VoiceThreads;
4. compiles bounded historical and application context;
5. applies network/context directives;
6. sends `response.create` with the compiled context;
7. stores the final assistant transcript and usage.

This prevents the provider's implicit conversation history from bypassing the Context Compiler.

## 4. Handle incoming SMS

Configure the Twilio number or Messaging Service inbound-message webhook to your SMS route.

```ts
import { OpenAITextResponseAdapter } from "@llmovoice/openai";
import { createTwilioSmsRuntimeHandler } from "@llmovoice/twilio";

const smsModel = new OpenAITextResponseAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  instructions: "Reply as the application assistant. Keep the message concise.",
  maxOutputTokens: 400,
});

const smsHandler = createTwilioSmsRuntimeHandler({
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  publicUrl: `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/twilio/sms`,
  idempotency: databaseTwilioIdempotency,

  async resolveMessage(message) {
    const identity = await resolveSmsIdentity(message.from, message.to);
    if (!identity || identity.blocked || !identity.smsConsent) return null;
    return {
      session: llmovoice.createSession({
        userId: identity.userId,
        sessionId: identity.stableMessagingSessionId,
        resume: true,
      }),
    };
  },

  async respond({ message, prepared }) {
    return smsModel.respond({
      message: message.body,
      context: prepared.context.rendered,
      directives: prepared.orchestration.directives,
    });
  },

  maxReplyCharacters: 1_600,
  onOptOut: (message) => recordSmsOptOut(message.from),
});

export const POST = smsHandler;
```

The default response uses TwiML `<Message>`, so no separate REST request is necessary. For asynchronous delivery and status callbacks, supply REST mode:

```ts
import { TwilioRestClient } from "@llmovoice/twilio";

const twilio = new TwilioRestClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
});

const delivery = {
  mode: "rest" as const,
  client: twilio,
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
  statusCallback: `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/twilio/message-status`,
};
```

`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, and `QUIT` are intercepted before model execution and passed to `onOptOut`. Keep Twilio Advanced Opt-Out enabled as the carrier-level compliance control as well.

## 5. Outbound calls and SMS

```ts
const twilio = new TwilioRestClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  defaultFrom: process.env.TWILIO_PHONE_NUMBER!,
});

await twilio.createCall({
  to: "+16045550123",
  openAIProjectId: process.env.OPENAI_PROJECT_ID!,
  maxDurationSeconds: 1_800,
  statusCallback: `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/twilio/call-status`,
});

await twilio.sendMessage({
  to: "+16045550123",
  body: "Your coaching session starts in 10 minutes.",
  statusCallback: `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/twilio/message-status`,
});
```

An outbound Twilio call first rings the destination, then bridges the answered leg to the OpenAI SIP endpoint. OpenAI emits the same `realtime.call.incoming` webhook, so the same authorization and Runtime sideband path applies.

## 6. Identity, security, and operations

Production applications must provide these policies:

- Map normalized E.164 caller/sender numbers to an authenticated application user. Phone-number possession alone may be insufficient for sensitive operations; use a PIN or step-up verification.
- Verify both OpenAI and Twilio webhook signatures before parsing or mutating data.
- Use database/Redis idempotency for webhook IDs, Message SIDs, Call SIDs, and status transitions.
- Keep a caller blocklist, country allowlist, concurrent-call limit, per-user rate limit, maximum duration, model token cap, and provider spend alerts.
- Require explicit SMS and call consent, honor opt-out, and implement quiet hours where applicable.
- Disclose recording and AI use as required. llmovoice does not persist call audio by default.
- Encrypt phone numbers and transcripts, minimize retention, and implement user export/deletion.
- Treat tool and application directive handlers as privileged server code.
- Run the sideband in a persistent, observable service with graceful shutdown.
- Test transfers, carrier errors, duplicate webhooks, sideband reconnect, provider timeout, blocked callers, and cost-limit hangup using real Twilio numbers before launch.

## 7. Verify locally

Provider-free unit and integration tests:

```bash
make test-telephony
```

For a real provider test, expose the webhook server through an HTTPS tunnel, configure the exact public URLs used in signature validation, call the Twilio number, and confirm:

- the OpenAI incoming webhook is verified once;
- the sideband stays connected for the call lifetime;
- caller and assistant transcripts complete one Page per turn;
- topic switches create or recover the expected Threads;
- SMS replies use the same user context;
- duplicate webhooks do not create duplicate Pages;
- token/duration limits hang up cleanly;
- call and message status callbacks reach terminal states.
