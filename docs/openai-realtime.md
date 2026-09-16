# OpenAI Realtime integration

## Authentication

The browser never receives a standard OpenAI API key.

1. The browser POSTs to `/api/realtime/token`.
2. The Next.js server uses `OPENAI_API_KEY` to create a short-lived client secret.
3. The browser uses that secret to establish a WebRTC session.
4. The standard key remains only in the server environment.

The implementation follows the official WebRTC client-secret architecture: <https://developers.openai.com/api/docs/guides/realtime-webrtc#connecting-using-an-ephemeral-token>.

The demo token route is same-origin, production fail-closed behind `LLMOVOICE_DEMO_ACCESS_TOKEN`, rate-limited per hashed identity, and caps token lifetime and model input/output. Its limiter is process-local; use Redis or an equivalent shared limiter when running more than one instance. Replace the demo bearer token with application identity and authorization before exposing user data.

The client waits for the data channel to reach `open` before declaring the call connected, serializes provider events, bounds outbound buffering, and uses exponential backoff for established-call reconnects. Token and SDP requests are abortable. Response interruption sends both `response.cancel` and `output_audio_buffer.clear`, matching the Realtime WebRTC conversation lifecycle.

## Turn control

The Realtime session uses server VAD to detect and commit a user turn, with automatic response creation disabled. When the final input transcript arrives:

1. `LlmovoiceSession` creates and routes the Page.
2. `ContextCompiler` produces bounded historical context.
3. `ControlOrchestrator` emits environment and context directives.
4. The adapter sends `response.create` with the compiled context as response-scoped instructions.

This ordering prevents the model from starting its response before relevant Thread history is selected.

The adapter samples WebRTC `getStats()` for RTT, jitter, packet loss, and available outgoing bitrate. The environment-first policy can change server-VAD silence, cancel or pause a response, pause local playback, and adjust output speed between responses. OpenAI currently permits speed values from `0.25` to `1.5`; llmovoice clamps all deterministic and model-proposed values to that interval.

Packet-loss values are calculated from interval deltas rather than lifetime counters. RTT, jitter, and loss use an EWMA and publish only material changes, preventing stable calls from generating unnecessary database reads and trace writes. `snapshot.performance` exposes connection setup, turn preparation, first-audio latency, telemetry samples, reconnect attempts, and outbound queue/drop counts.

By default, llmovoice deletes provider conversation items that have already been captured as durable Pages unless the compiler selected their audio representation. This prevents the provider's implicit conversation history from silently bypassing the compiler budget while preserving provider-native audio only where it is useful.

## Network mixer

The demo shows actual transport telemetry and also offers a `SIMULATED OVERRIDE` that changes llmovoice policy input. The override does not modify the physical WebRTC route. True packet impairment belongs in an AudioWorklet or server-side media proxy and should be evaluated separately.

## Provider event compatibility

The adapter maps current and legacy audio-transcript event names into a canonical llmovoice event stream. Unknown provider events remain available through `onRawEvent` for observability and forward compatibility.

## SIP calls

`OpenAISipController` wraps the official accept, reject, refer, and hang-up endpoints. `OpenAISipSidebandClient` connects the accepted `call_id` to a `LlmovoiceSession`, and `OpenAISipRuntime` owns concurrent-call admission, lifecycle, limits, and cleanup. A safe server flow is:

1. Receive the `realtime.call.incoming` webhook with `createOpenAISipWebhookHandler`.
2. Supply its mandatory `verify` callback using the official OpenAI SDK webhook helper or the Standard Webhooks specification; the handler never parses an unverified event.
3. Authorize the called number and caller under application policy.
4. Resolve the SIP `From`/`To` headers to an authorized user and stable session.
5. Accept the call with automatic response creation disabled and connect the server-side sideband WebSocket.
6. Feed transcript events into `LlmovoiceSession`; the sideband waits for routing and compilation before sending `response.create`.
7. Execute private tools/directives, record usage, enforce token/duration limits, and clean up on hangup.

For horizontally scaled servers, supply `claimEvent` backed by Redis or a database unique constraint so repeated webhook deliveries are idempotent. The handler also enforces a bounded body size and returns retryable server errors when application call handling fails.

The library intentionally does not treat JSON parsing as webhook verification. The `@llmovoice/twilio` package implements signed Twilio Voice/SMS webhooks, PSTN-to-SIP routing, outbound calls/messages, status callbacks, and SMS Runtime handling. Carrier provisioning, phone-number ownership, consent, recording disclosure, emergency-call handling, regional rules, and abuse controls remain deployment responsibilities. See [Twilio Voice, OpenAI SIP, and SMS](./telephony.md).

Official references: <https://developers.openai.com/api/docs/guides/realtime-sip>, <https://developers.openai.com/api/docs/guides/realtime-server-controls>, and <https://developers.openai.com/api/docs/guides/webhooks>.
