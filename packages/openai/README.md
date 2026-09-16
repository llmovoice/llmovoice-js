# @llmovoice/openai

OpenAI Realtime WebRTC, Responses/embedding workers, and SIP call-control helpers for llmovoice.js.

```bash
pnpm add @llmovoice/openai @llmovoice/runtime
```

Standard OpenAI API keys must remain on the server. Browser clients receive only short-lived Realtime client secrets.

```ts
import {
  createOpenAIRealtimeClientSecret,
  createOpenAISipWebhookHandler,
  OpenAIEmbeddingAdapter,
  OpenAIOrchestrationReasoner,
  OpenAIRealtimeClient,
  OpenAISipController,
  OpenAISipRuntime,
  OpenAISipSidebandClient,
  OpenAIStateExtractionAdapter,
  OpenAISummaryAdapter,
  OpenAITextResponseAdapter,
} from "@llmovoice/openai";
```

`OpenAIRealtimeClient` keeps the Context Compiler authoritative by deleting provider conversation items already materialized as Pages, except items selected at audio fidelity. It also maps WebRTC telemetry and bounded runtime directives onto provider controls. Application/tool directives execute only through explicitly supplied executors.

Realtime transport behavior includes abortable handshakes, data-channel readiness, bounded backpressure, ordered event processing, bounded exponential reconnect, delta-based packet loss, EWMA telemetry, and connection/turn/first-audio timing metrics.

`createOpenAISipWebhookHandler` requires an application-supplied signature verifier before it exposes an incoming call, supports a distributed idempotency claim callback, and bounds request size. Carrier provisioning, authorization, consent, and a persistent process for the sideband connection remain application responsibilities.

`OpenAISipRuntime` now supplies the full server-side sideband connection: verified incoming-call resolution, accept/reject, transcript-to-Page mapping, context-before-response ordering, provider-history trimming, private tools/directives, bounded reconnect, usage accounting, token/duration limits, and lifecycle cleanup. Pair it with `@llmovoice/twilio` for Twilio PSTN and SMS transport.

`OpenAITextResponseAdapter` applies the same compiled context and orchestration instructions to asynchronous text channels such as SMS, with abortable requests, bounded output, and optional per-user safety identifiers.

See the [llmovoice.js repository](https://github.com/llmovoice/llmovoice-js) for a complete Next.js example.
