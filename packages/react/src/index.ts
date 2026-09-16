"use client";

import { useEffect, useState } from "react";
import type { OpenAIRealtimeClient, RealtimeClientSnapshot } from "@llmovoice/openai";
import type { LlmovoiceSession, RuntimeSnapshot } from "@llmovoice/runtime";

export function useLlmovoiceRuntime(session: LlmovoiceSession): RuntimeSnapshot | null {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  useEffect(() => session.subscribe(setSnapshot), [session]);
  return snapshot;
}

export function useOpenAIRealtimeClient(client: OpenAIRealtimeClient | null): RealtimeClientSnapshot | null {
  const [snapshot, setSnapshot] = useState<RealtimeClientSnapshot | null>(client?.snapshot ?? null);
  useEffect(() => {
    if (!client) {
      setSnapshot(null);
      return;
    }
    setSnapshot(client.snapshot);
    return client.subscribe(setSnapshot);
  }, [client]);
  return snapshot;
}
