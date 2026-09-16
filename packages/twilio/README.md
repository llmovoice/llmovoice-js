# @llmovoice/twilio

Twilio Voice, SIP, and SMS transport adapters for llmovoice.js.

```bash
pnpm add @llmovoice/twilio @llmovoice/openai @llmovoice/runtime
```

The package provides:

- Twilio webhook signature verification against the exact public URL and all form fields;
- inbound Programmable Voice → OpenAI SIP TwiML routing;
- outbound PSTN calls bridged to OpenAI Realtime SIP;
- inbound SMS → `prepareSmsTurn()` → reply delivery;
- outbound SMS and message/call status callbacks;
- pluggable idempotency, caller/message authorization, opt-out, and lifecycle hooks;
- hard message and call-duration bounds.

OpenAI call acceptance and the server-side sideband Runtime live in `@llmovoice/openai`. Use `OpenAISipRuntime` to map a verified `realtime.call.incoming` event to an authenticated user session, compile context before every spoken response, execute private tools, and persist the final transcripts.

`MemoryTwilioWebhookIdempotency` is for a single process. Multi-instance production deployments must supply a Redis or database implementation of `TwilioWebhookIdempotency`.

See the [Twilio Voice and SMS deployment guide](https://github.com/llmovoice/llmovoice-js/blob/main/docs/telephony.md) for complete routes and provider configuration.
