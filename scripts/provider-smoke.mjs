const enabled = process.env.LLMOVOICE_PROVIDER_REAL === "1";
if (!enabled) {
  console.error("Set LLMOVOICE_PROVIDER_REAL=1 to allow one real provider request.");
  process.exit(2);
}

const provider = process.env.LLMOVOICE_PROVIDER;
const apiKey = process.env.LLMOVOICE_PROVIDER_API_KEY;
const allowed = new Set(["qwen", "glm", "baidu", "minimax", "doubao", "hunyuan", "deepseek", "moonshot"]);
if (!provider || !allowed.has(provider)) {
  console.error(`LLMOVOICE_PROVIDER must be one of: ${[...allowed].join(", ")}.`);
  process.exit(2);
}
if (!apiKey) {
  console.error("LLMOVOICE_PROVIDER_API_KEY is required.");
  process.exit(2);
}

const { createMainlandTextAdapters } = await import("../packages/providers/dist/index.js");
const adapters = createMainlandTextAdapters(provider, {
  apiKey,
  ...(process.env.LLMOVOICE_PROVIDER_MODEL ? { model: process.env.LLMOVOICE_PROVIDER_MODEL } : {}),
  ...(process.env.LLMOVOICE_PROVIDER_BASE_URL ? { baseUrl: process.env.LLMOVOICE_PROVIDER_BASE_URL } : {}),
  timeoutMs: 15_000,
  maxOutputTokens: 80,
});
const reply = await adapters.text.respond({
  message: "只回复 LLMOVOICE_PROVIDER_OK",
  context: "This is a minimal connectivity smoke test.",
  instructions: "Follow the user exactly. Output only the requested token.",
});
if (!reply.includes("LLMOVOICE_PROVIDER_OK")) {
  console.error(`Provider returned an unexpected response: ${reply.slice(0, 200)}`);
  process.exit(1);
}
console.log(`${provider}: real provider smoke test passed.`);
