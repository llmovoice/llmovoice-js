export interface OpenAIRealtimeSecretOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions?: string;
  safetyIdentifier?: string;
  expiresInSeconds?: number;
  transcriptionModel?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpenAIRealtimeClientSecret {
  value: string;
  expires_at: number;
  session?: Record<string, unknown>;
}

export async function createOpenAIRealtimeClientSecret(
  options: OpenAIRealtimeSecretOptions,
): Promise<OpenAIRealtimeClientSecret> {
  if (!options.apiKey.trim()) throw new Error("An OpenAI API key is required.");

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...(options.safetyIdentifier ? { "OpenAI-Safety-Identifier": options.safetyIdentifier } : {}),
    },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(1_000, options.timeoutMs ?? 8_000))])
      : AbortSignal.timeout(Math.max(1_000, options.timeoutMs ?? 8_000)),
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: options.expiresInSeconds ?? 600,
      },
      session: {
        type: "realtime",
        model: options.model ?? "gpt-realtime-2.1",
        output_modalities: ["audio"],
        max_output_tokens: Math.max(1, Math.min(4_096, options.maxOutputTokens ?? 1_024)),
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: {
            post_instructions: Math.max(1_000, options.maxInputTokens ?? 8_000),
          },
        },
        instructions: options.instructions ?? "You are a concise, helpful realtime voice assistant.",
        audio: {
          input: {
            transcription: {
              model: options.transcriptionModel ?? "gpt-4o-mini-transcribe",
            },
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 320,
              create_response: false,
              interrupt_response: true,
            },
          },
          output: {
            voice: options.voice ?? "marin",
            speed: 1,
          },
        },
      },
    }),
  });

  const data = await response.json() as OpenAIRealtimeClientSecret & { error?: { message?: string } };
  if (!response.ok || !data.value) {
    throw new Error(data.error?.message ?? `OpenAI client secret request failed (${response.status}).`);
  }
  return data;
}
