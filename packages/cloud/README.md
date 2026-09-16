# @llmovoice/cloud

Server-side `ContextStore` for the managed llmovoice Cloud service.

```ts
import { CloudContextStore } from "@llmovoice/cloud";
import { createLlmovoice } from "@llmovoice/runtime";

const store = new CloudContextStore({
  apiKey: process.env.LLMOVOICE_API_KEY!,
  userId: authenticatedUser.id,
});

const runtime = createLlmovoice({ store });
```

Project keys are server secrets and must never be included in browser bundles or `NEXT_PUBLIC_*` variables.
