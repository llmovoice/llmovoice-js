# @llmovoice/providers

Mainland China text, embedding, and server-side realtime voice adapters for llmovoice.js.

```bash
pnpm add @llmovoice/providers @llmovoice/runtime
```

Text adapters are available for Qwen, GLM, Baidu Qianfan, MiniMax, Doubao/Volcengine Ark, Tencent Hunyuan, DeepSeek, and Moonshot/Kimi. Realtime WebSocket profiles are available for Qwen-Audio, GLM-Realtime, Baidu's end-to-end speech language model, and MiniMax Realtime.

Use `embeddingDimensions` when your vector store has a fixed width. A mismatched provider response is rejected before persistence instead of failing later in the database.

```ts
import { createMainlandTextAdapters } from "@llmovoice/providers";
import { createLlmovoice } from "@llmovoice/runtime";

const qwen = createMainlandTextAdapters("qwen", {
  apiKey: process.env.DASHSCOPE_API_KEY!,
  model: "qwen-plus",
  embeddingModel: "text-embedding-v4",
});

const llmovoice = createLlmovoice({
  embedding: qwen.embedding,
  summary: qwen.summary,
  stateExtractor: qwen.stateExtractor,
  orchestrationReasoner: qwen.orchestrationReasoner,
});
```

Realtime providers require a trusted Node.js server because their WebSocket handshakes use an `Authorization` header. `MainlandRealtimeClient` accepts and emits base64 PCM frames; connect it to your browser media bridge, RTC service, or domestic telephony provider.

```ts
import { MainlandRealtimeClient } from "@llmovoice/providers";

const client = new MainlandRealtimeClient({
  provider: "qwen",
  apiKey: process.env.DASHSCOPE_API_KEY!,
  workspaceId: process.env.DASHSCOPE_WORKSPACE_ID,
  runtimeSession: llmovoice.createSession({ userId, sessionId, resume: true }),
  onAudioDelta: (base64Pcm) => mediaBridge.send(base64Pcm),
});

await client.connect();
mediaBridge.onAudio((base64Pcm) => client.appendAudio(base64Pcm));
mediaBridge.onEndOfTurn(() => client.commitAudio());
```

Qwen, GLM, and MiniMax profiles default to manual turn commit so llmovoice can compile context before creating the model response. Baidu's currently documented endpoint uses provider-managed VAD and automatic responses; its profile declares `contextTiming: "next-turn"` rather than pretending to provide the same ordering guarantee. Profiles also expose `capabilities.maturity`: Qwen and GLM are `stable`, Baidu is `provider-managed`, and MiniMax Realtime is `legacy` because its public WebSocket contract/model is older and must be verified for the target account.

See the repository's [mainland China providers guide](../../docs/mainland-china.md) for endpoints, capabilities, deployment boundaries, and real credential smoke tests.
