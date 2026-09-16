import type { ContextUnit, VoicePage, VoiceThread } from "@llmovoice/core";

export const systemClock = { now: () => new Date() };

export function createId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1),
    ),
  );
}

export function lexicalSimilarity(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  return lexicalSetSimilarity(a, b);
}

export function lexicalSetSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const jaccard = intersection / (a.size + b.size - intersection);
  const smallerSetCoverage = intersection / Math.min(a.size, b.size);
  // Thread summaries grow over time, so pure Jaccard unfairly penalizes a
  // focused query that is substantially contained by a longer thread.
  return clamp(Math.max(jaccard, smallerSetCoverage * 0.72));
}

export function cosineSimilarity(left?: number[], right?: number[]): number {
  if (!left || !right || left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return clamp(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

export function unitId(unit: ContextUnit): string {
  return unit.value.id;
}

export function unitText(unit: ContextUnit): string {
  if (unit.kind === "page") {
    const page = unit.value;
    return [page.input.transcript, page.output?.transcript, page.summary].filter(Boolean).join("\n");
  }
  if (unit.kind === "thread") return `${unit.value.title}\n${unit.value.summary}`;
  return `${unit.value.title ?? ""}\n${unit.value.content}\n${unit.value.summary ?? ""}`;
}

export function pageText(page: VoicePage): string {
  return [page.input.transcript, page.output?.transcript, page.summary].filter(Boolean).join(" ");
}

export function threadText(thread: VoiceThread): string {
  return `${thread.title} ${thread.summary}`.trim();
}

export function estimateWords(text: string): number {
  const latinWords = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const cjkCharacters = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return Math.max(latinWords, Math.ceil(cjkCharacters / 1.8));
}

export function compactText(text: string, maxCharacters: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`;
}

export function defaultTitle(text: string): string {
  const compact = compactText(text, 46);
  return compact || "Untitled conversation";
}

export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  message: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(message)), Math.max(1, milliseconds));
  let removeAbortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? new Error(message));
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (error) {
    if (controller.signal.aborted && !parentSignal?.aborted) throw new Error(message, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    removeAbortListener?.();
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}
