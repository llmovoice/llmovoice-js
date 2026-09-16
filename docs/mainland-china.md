# Mainland China model providers

`@llmovoice/providers` keeps model inference separate from media transport, storage, and the Context Runtime. Applications can use a domestic model endpoint while retaining their own database and carrier.

## Supported providers

| Provider | Text / summary / state / orchestration | Embedding | Realtime voice | Context timing | Realtime maturity |
| --- | --- | --- | --- | --- | --- |
| Alibaba Cloud Qwen | Yes | Yes | Qwen-Audio WebSocket | Before response | Stable profile |
| Zhipu GLM | Yes | Yes | GLM-Realtime WebSocket | Before response | Stable profile |
| Baidu Qianfan | Yes | Yes | End-to-end speech WebSocket | Next turn | Provider-managed response |
| MiniMax China | Yes | Custom model required if embedding is needed | Legacy MiniMax Realtime WebSocket | Before response | Legacy public contract; verify account access |
| Volcengine Ark / Doubao | Yes | Configure an embedding endpoint/model | Use an application RTC/ASR/TTS bridge | N/A | N/A |
| Tencent TokenHub / Hunyuan | Yes | Yes | Use TRTC/ASR/TTS or another media bridge | N/A | N/A |
| DeepSeek | Yes | No native embedding in this package | Text reasoning only | N/A | N/A |
| Moonshot / Kimi | Yes | Configure separately | Text reasoning only | N/A | N/A |

Provider model names evolve independently. Every factory default can be overridden with `model`, `embeddingModel`, and `baseUrl`.

If the backing vector column has a fixed width, pass `embeddingDimensions` and use a provider model that supports it. The adapter sends the requested dimension and rejects a mismatched response before it reaches storage. For example, the included Supabase schema uses `vector(1536)`, so Qwen can be configured with `embeddingModel: "text-embedding-v4", embeddingDimensions: 1536`. Do not silently mix vectors from models with different dimensions in one index.

## Text Runtime

```ts
import { createMainlandTextAdapters } from "@llmovoice/providers";
import { createLlmovoice } from "@llmovoice/runtime";

const provider = createMainlandTextAdapters("deepseek", {
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-flash",
  timeoutMs: 6_000,
});

const runtime = createLlmovoice({
  summary: provider.summary,
  stateExtractor: provider.stateExtractor,
  orchestrationReasoner: provider.orchestrationReasoner,
});

const session = runtime.createSession({ userId: "user-123", resume: true });
const prepared = await session.prepareSmsTurn("继续昨天的训练计划");
const reply = await provider.text.respond({
  message: prepared.page.input.transcript,
  context: prepared.context.rendered,
  directives: prepared.orchestration.directives,
  userId: "non-identifying-stable-user-hash",
});
await session.ingest({
  type: "assistant.transcript.completed",
  text: reply,
  at: new Date().toISOString(),
});
```

The generic implementation uses OpenAI-compatible `chat/completions` and `embeddings` shapes, not OpenAI infrastructure. Requests go directly to the configured provider endpoint.

## Realtime Runtime

The realtime client is deliberately server-side:

```text
Browser / domestic carrier / RTC
              │ base64 PCM
              ▼
     MainlandRealtimeClient
              │ transcript events
              ▼
      llmovoice Runtime
              │ compiled projection
              ▼
   Qwen / GLM / Baidu / MiniMax
```

```ts
import { MainlandRealtimeClient } from "@llmovoice/providers";

const realtime = new MainlandRealtimeClient({
  provider: "glm",
  apiKey: process.env.GLM_API_KEY!,
  runtimeSession: session,
  baseInstructions: "你是 CoachGPT。保持简洁，遵守用户长期目标和安全边界。",
  onAudioDelta: async (audio) => media.sendAudio(audio),
  onToolCall: async ({ name, arguments: args }) => tools.execute(name, args),
  reconnect: { maxAttempts: 3, initialDelayMs: 300, maxDelayMs: 5_000 },
});

await realtime.connect();
media.onAudio((audio) => realtime.appendAudio(audio));
media.onEndOfTurn(() => realtime.commitAudio());
```

`snapshot.contextTiming` is a machine-readable compatibility guarantee:

- `before-response`: the profile uses an explicit/manual response path and injects the compiled projection before triggering inference.
- `next-turn`: the provider's public protocol automatically starts inference. The Runtime still persists the current Page and updates session context, but cannot guarantee that current-turn projection is visible to the already-started response.

Do not hide this distinction in an application SLA.

`snapshot.maturity` (and `realtime.profile.capabilities.maturity`) is also explicit. `stable` means the preset tracks a current public protocol; `provider-managed` means the provider controls a critical response-timing step; `legacy` means the adapter is retained for compatible accounts but the application must supply and verify a currently enabled model before production rollout.

## Official endpoints represented by the presets

- Qwen text: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Qwen Realtime: Beijing workspace endpoint or `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` (default `qwen-audio-3.0-realtime-flash`, 16 kHz PCM input, 24 kHz PCM output)
- GLM text/realtime: `https://open.bigmodel.cn/api/paas/v4` and `wss://open.bigmodel.cn/api/paas/v4/realtime`
- Baidu Qianfan text/realtime: `https://qianfan.baidubce.com/v2` and `wss://aip.baidubce.com/ws/2.0/speech/v1/realtime`
- MiniMax China: `https://api.minimaxi.com/v1`; the legacy public Realtime contract used `wss://api.minimax.chat/ws/v1/realtime`, so pass an account-enabled `model` and verify availability before deployment
- Volcengine Ark: `https://ark.cn-beijing.volces.com/api/v3`
- Tencent TokenHub / Hunyuan: `https://tokenhub.tencentmaas.com/v1` (default `hy3`; the old Hunyuan OpenAI-compatible platform is scheduled to shut down on 2026-09-30)
- DeepSeek: `https://api.deepseek.com`
- Moonshot: `https://api.moonshot.cn/v1`

Review provider documentation before production because models, quotas, content policies, and regional endpoints can change.

## Security and deployment

- Keep all provider keys on trusted servers. The realtime providers require authentication headers that browser WebSocket APIs cannot safely set.
- Use a stable non-identifying user hash when sending a provider user identifier.
- Apply provider and application rate limits independently.
- Store Pages and Threads in a database region compatible with the application's data-residency requirements.
- Domestic model availability does not provide a domestic phone number. Use a licensed local carrier/CPaaS or an approved RTC service for Mainland China telephony and messaging.
- Obtain consent for recording, transcription, profiling, and voice cloning where applicable.

## Tests

Offline protocol and Runtime tests do not call paid APIs:

```bash
pnpm test:providers
```

A real text smoke test is opt-in and makes one billable provider request:

```bash
LLMOVOICE_PROVIDER_REAL=1 \
LLMOVOICE_PROVIDER=qwen \
LLMOVOICE_PROVIDER_API_KEY=... \
pnpm test:providers:real
```

Optional overrides are `LLMOVOICE_PROVIDER_MODEL` and `LLMOVOICE_PROVIDER_BASE_URL`.
