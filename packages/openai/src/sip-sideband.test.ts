import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLlmovoice } from "@llmovoice/runtime";
import {
  OpenAISipSidebandClient,
  type OpenAISipSidebandSocket,
} from "./sip-sideband";

class FakeSocket extends EventEmitter implements OpenAISipSidebandSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(event: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.close(1006, "terminated");
  }
}

describe("OpenAI SIP sideband runtime", () => {
  it("maps phone transcripts through the runtime before creating a response", async () => {
    const runtime = createLlmovoice();
    const session = runtime.createSession({ userId: "phone-user", sessionId: "phone-session" });
    const socket = new FakeSocket();
    const client = new OpenAISipSidebandClient({
      apiKey: "sk-test",
      callId: "rtc_12345678",
      runtimeSession: session,
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });

    await client.connect();
    socket.message({ type: "input_audio_buffer.speech_started" });
    socket.message({ type: "input_audio_buffer.speech_stopped" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_phone_user_1",
      transcript: "Remember that I need a dog-friendly hotel under $200.",
    });

    await vi.waitFor(() => {
      expect(socket.sent.some((event) => event.type === "response.create")).toBe(true);
    });
    const responseCreate = socket.sent.find((event) => event.type === "response.create");
    expect(JSON.stringify(responseCreate)).toContain("dog-friendly hotel");

    socket.message({
      type: "response.output_audio_transcript.done",
      item_id: "item_phone_assistant_1",
      transcript: "I will keep those constraints together.",
    });
    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.pages[0]?.status).toBe("complete");
      expect(snapshot.pages[0]?.output?.modality).toBe("audio");
    });
    await client.close();
  });

  it("executes server tools and enforces token limits", async () => {
    const socket = new FakeSocket();
    const onToolCall = vi.fn(async () => ({ available: true }));
    const onLimit = vi.fn(async () => undefined);
    const client = new OpenAISipSidebandClient({
      apiKey: "sk-test",
      callId: "rtc_abcdefgh",
      runtimeSession: createLlmovoice().createSession({ userId: "u1" }),
      maxTotalTokens: 10,
      onToolCall,
      onLimit,
      webSocketFactory: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
      reconnect: false,
    });
    await client.connect();
    socket.message({
      type: "response.function_call_arguments.done",
      call_id: "tool_call_1",
      name: "lookup",
      arguments: "{\"city\":\"Vancouver\"}",
    });
    socket.message({
      type: "response.done",
      response: { usage: { input_tokens: 8, output_tokens: 4, input_token_details: { cached_tokens: 2 } } },
    });
    await vi.waitFor(() => {
      expect(onToolCall).toHaveBeenCalledWith({ callId: "tool_call_1", name: "lookup", arguments: { city: "Vancouver" } });
      expect(onLimit).toHaveBeenCalledWith("tokens");
    });
    expect(socket.sent.some((event) => {
      const item = event.item as Record<string, unknown> | undefined;
      return event.type === "conversation.item.create" && item?.type === "function_call_output";
    })).toBe(true);
    await client.close();
  });
});
