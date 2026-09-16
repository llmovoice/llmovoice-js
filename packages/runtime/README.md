# @llmovoice/runtime

The provider-independent context runtime for llmovoice.js: VoicePages, VoiceThreads, budgeted context compilation, state reduction, and control orchestration.

```bash
pnpm add @llmovoice/runtime
```

```ts
import { createLlmovoice } from "@llmovoice/runtime";

const runtime = createLlmovoice();
const session = runtime.createSession({ userId: "user_123" });
const turn = await session.prepareTextTurn("Return to my hotel plan.");
```

Reuse a persisted session ID to restore sequence, the latest state snapshot, and active Thread hints after page re-entry:

```ts
const session = runtime.createSession({ userId, sessionId, resume: true });
```

`HttpContextSource` adapts a user-authenticated application endpoint to compiler context. It forwards the compiler's `AbortSignal`, bounds returned units, and never includes `userId` in the URL by default.

Model state extraction runs in the background by default to protect first-response latency. Use `stateExtractionMode: "blocking"` only when the current response requires it. Adapter deadlines propagate `AbortSignal`; recent-history reads are bounded and concurrent; PostgreSQL/Supabase stores automatically enable durable enrichment leases.

See the [llmovoice.js repository](https://github.com/llmovoice/llmovoice-js) for full documentation.
