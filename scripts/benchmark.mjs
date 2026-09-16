import { performance } from "node:perf_hooks";
import { createLlmovoice } from "../packages/runtime/dist/index.js";

const turns = Math.max(20, Number(process.argv.find((value) => value.startsWith("--turns="))?.split("=")[1] ?? 120));
const warmup = Math.min(20, Math.floor(turns / 6));
const durations = [];
const session = createLlmovoice().createSession({ userId: "benchmark-user", sessionId: "benchmark-session" });

for (let index = 0; index < turns + warmup; index += 1) {
  const startedAt = performance.now();
  await session.prepareTextTurn(`Plan item ${index % 17}: preserve constraint ${index % 5} and continue the active project.`);
  const duration = performance.now() - startedAt;
  await session.ingest({
    type: "assistant.transcript.completed",
    text: `Recorded plan item ${index % 17}.`,
    at: new Date().toISOString(),
  });
  await session.waitForEnrichment();
  if (index >= warmup) durations.push(duration);
}

durations.sort((left, right) => left - right);
const percentile = (value) => durations[Math.min(durations.length - 1, Math.floor(durations.length * value))] ?? 0;
const result = {
  turns,
  p50Ms: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  maxMs: Number(Math.max(...durations).toFixed(2)),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
