import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@llmovoice/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@llmovoice/runtime": fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url)),
      "@llmovoice/openai": fileURLToPath(new URL("./packages/openai/src/index.ts", import.meta.url)),
      "@llmovoice/providers": fileURLToPath(new URL("./packages/providers/src/index.ts", import.meta.url)),
      "@llmovoice/twilio": fileURLToPath(new URL("./packages/twilio/src/index.ts", import.meta.url)),
      "@llmovoice/postgres": fileURLToPath(new URL("./packages/postgres/src/index.ts", import.meta.url)),
      "@llmovoice/supabase": fileURLToPath(new URL("./packages/supabase/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["packages/{runtime,openai,providers,postgres,supabase,twilio}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "packages/{runtime,openai,providers,twilio}/src/index.ts"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 80,
        lines: 85,
      },
    },
  },
});
