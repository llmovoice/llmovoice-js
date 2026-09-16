"use client";

import { useEffect, useMemo, useState } from "react";
import type { ContextSource, Directive, ExternalContextUnit, VoicePage, VoiceThread } from "@llmovoice/core";
import { OpenAIRealtimeClient } from "@llmovoice/openai";
import { useOpenAIRealtimeClient } from "@llmovoice/react";
import { createLlmovoice, HttpContextSource } from "@llmovoice/runtime";
import { SupabaseContextStore, SupabaseTableContextSource } from "@llmovoice/supabase";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

const seededTurns = [
  {
    user: "I'm planning a Vancouver trip next week. Keep the hotel under $200 and it must allow dogs.",
    assistant: "Got it: Vancouver next week, under $200, and dog-friendly.",
  },
  {
    user: "For my client meeting, help me ask about their launch timeline and biggest delivery risk.",
    assistant: "I would ask when the launch decision becomes irreversible and which delivery risk worries them most.",
  },
  {
    user: "Back to the Vancouver hotel trip: keep it under $200 and dog-friendly, and I'd also prefer somewhere near a park.",
    assistant: "I'll keep the budget, dog-friendly requirement, and proximity to a park together.",
  },
];

function formatMoney(value: number): string {
  if (value === 0) return "$0.0000";
  return `$${value.toFixed(4)}`;
}

function shortId(id: string): string {
  return id.split("_")[1]?.slice(0, 6) ?? id.slice(0, 6);
}

function fidelityTone(fidelity: string): string {
  if (fidelity === "audio") return "violet";
  if (fidelity === "transcript") return "green";
  if (fidelity === "summary") return "amber";
  return "muted";
}

function mapCoachGptState(body: unknown): ExternalContextUnit[] {
  if (!body || typeof body !== "object") return [];
  const state = "state" in body && body.state && typeof body.state === "object"
    ? body.state as Record<string, unknown>
    : body as Record<string, unknown>;
  const units: ExternalContextUnit[] = [];
  const personal = Array.isArray(state.personalContext) ? state.personalContext : [];
  for (const value of personal) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.summary !== "string") continue;
    units.push({
      id: `coachgpt:${item.id}`,
      source: "coachgpt",
      content: item.summary,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.sensitivity === "string" ? { sensitivity: item.sensitivity } : {}),
      ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
      metadata: { kind: item.kind, confidence: item.confidence },
    });
  }
  const goals = Array.isArray(state.goals) ? state.goals : [];
  for (const value of goals) {
    if (!value || typeof value !== "object") continue;
    const goal = value as Record<string, unknown>;
    if (typeof goal.id !== "string" || typeof goal.title !== "string") continue;
    units.push({
      id: `coachgpt:goal:${goal.id}`,
      source: "coachgpt",
      title: "Active coaching goal",
      content: [goal.title, typeof goal.nextMove === "string" ? `Next move: ${goal.nextMove}` : ""].filter(Boolean).join("\n"),
      ...(typeof goal.updatedAt === "string" ? { updatedAt: goal.updatedAt } : {}),
      metadata: { kind: "goal", status: goal.status, confidence: goal.confidence },
    });
  }
  const memory = state.memory && typeof state.memory === "object" ? state.memory as Record<string, unknown> : null;
  const profile = memory?.profile && typeof memory.profile === "object" ? memory.profile as Record<string, unknown> : null;
  if (profile) {
    const profileText = [
      typeof profile.name === "string" ? `Name: ${profile.name}` : "",
      typeof profile.preferredLanguage === "string" ? `Preferred language: ${profile.preferredLanguage}` : "",
      Array.isArray(profile.focusAreas) ? `Focus areas: ${profile.focusAreas.join(", ")}` : "",
    ].filter(Boolean).join(" · ");
    if (profileText) units.push({ id: "coachgpt:profile", source: "coachgpt", title: "Coaching profile", content: profileText, metadata: { kind: "profile" } });
  }
  return units;
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const llmovoiceSchema = process.env.NEXT_PUBLIC_LLMOVOICE_SCHEMA ?? "llmovoice";

type LabIdentity = {
  user: User | null;
  accessToken: string;
  supabase: SupabaseClient | null;
  mode: "supabase" | "local";
};

export function LiveLab() {
  const [identity, setIdentity] = useState<LabIdentity | null>(null);

  useEffect(() => {
    if (!supabaseUrl || !supabaseKey) {
      setIdentity({ user: null, accessToken: sessionStorage.getItem("llmovoice-demo-token") ?? "", supabase: null, mode: "local" });
      return;
    }
    const supabase = createClient(supabaseUrl, supabaseKey);
    void supabase.auth.getSession().then(({ data }) => {
      setIdentity({ user: data.session?.user ?? null, accessToken: data.session?.access_token ?? "", supabase, mode: "supabase" });
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setIdentity({ user: session?.user ?? null, accessToken: session?.access_token ?? "", supabase, mode: "supabase" });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!identity) return <AuthStatus message="Loading authenticated context…" />;
  if (identity.mode === "supabase" && !identity.user && identity.supabase) {
    return <SupabaseLogin supabase={identity.supabase} />;
  }
  const userId = identity.user?.id ?? "demo-user";
  return <RuntimeLab key={userId} identity={identity} userId={userId} />;
}

function RuntimeLab({ identity, userId }: { identity: LabIdentity; userId: string }) {
  const { runtime, session, client } = useMemo(() => {
    const store = identity.supabase
      ? new SupabaseContextStore({ client: identity.supabase, userId, schema: llmovoiceSchema, vectorDimensions: 1536 })
      : undefined;
    const sources: ContextSource[] = [];
    const coachEndpoint = process.env.NEXT_PUBLIC_COACHGPT_CONTEXT_ENDPOINT;
    if (coachEndpoint) {
      sources.push(new HttpContextSource({
        name: "coachgpt",
        endpoint: coachEndpoint,
        appendQuery: false,
        credentials: "include",
        ...(identity.accessToken ? { headers: { Authorization: `Bearer ${identity.accessToken}` } } : {}),
        mapResponse: mapCoachGptState,
      }));
    } else if (identity.supabase) {
      sources.push(new SupabaseTableContextSource<Record<string, unknown>>({
        client: identity.supabase,
        name: "coachgpt",
        schema: process.env.NEXT_PUBLIC_COACHGPT_SCHEMA ?? "coachgpt",
        table: process.env.NEXT_PUBLIC_COACHGPT_CONTEXT_TABLE ?? "personal_context_items",
        filters: { status: "active", kind: ["profile", "goal", "preference", "safety_boundary"] },
        mapRow: (row) => {
          const id = typeof row.id === "string" ? row.id : "";
          const summary = typeof row.summary === "string" ? row.summary.trim() : "";
          if (!id || !summary) return null;
          return {
            id: `coachgpt:${id}`,
            source: "coachgpt",
            ...(typeof row.title === "string" ? { title: row.title } : {}),
            content: summary,
            summary,
            ...(typeof row.sensitivity === "string" ? { sensitivity: row.sensitivity } : {}),
            metadata: { kind: row.kind, confidence: row.confidence, consent: row.status === "active" },
            ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}),
          };
        },
      }));
    }
    const embedding = identity.supabase ? {
      embed: async (text: string, options: { signal?: AbortSignal } = {}) => {
        const response = await fetch("/api/embedding", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.accessToken}` },
          body: JSON.stringify({ text }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const body = await response.json() as { embedding?: number[]; error?: string };
        if (!response.ok || !body.embedding) throw new Error(body.error ?? `Embedding failed (${response.status}).`);
        return body.embedding;
      },
    } : undefined;
    const runtimeInstance = createLlmovoice({
      ...(store ? { store } : {}),
      ...(embedding ? { embedding } : {}),
      sources,
      compiler: {
        budget: { maxInputTokens: 3_000, reservedOutputTokens: 600 },
        costModel: {
          audioTokensPerSecond: 10,
          textTokensPerWord: 1.33,
          inputTextUsdPerMillionTokens: 4,
          inputAudioUsdPerMillionTokens: 32,
        },
      },
    });
    const storageKey = `llmovoice:session:${userId}`;
    const persistedSessionId = window.localStorage.getItem(storageKey) ?? `web-${crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, persistedSessionId);
    const sessionInstance = runtimeInstance.createSession({
      userId,
      sessionId: persistedSessionId,
      resume: true,
    });
    const clientInstance = new OpenAIRealtimeClient({
      tokenEndpoint: "/api/realtime/token",
      runtimeSession: sessionInstance,
      baseInstructions: "Respond naturally and concisely. Respect all relevant constraints in the llmovoice context.",
      tokenHeaders: () => {
        const token = identity.mode === "supabase"
          ? identity.accessToken
          : window.sessionStorage.getItem("llmovoice-demo-token") ?? "";
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    });
    return { runtime: runtimeInstance, session: sessionInstance, client: clientInstance };
  }, [identity, userId]);

  const realtime = useOpenAIRealtimeClient(client);
  const snapshot = realtime?.runtime;
  const [text, setText] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [network, setNetwork] = useState({ latencyMs: 45, jitterMs: 8, packetLoss: 0 });
  const [activePanel, setActivePanel] = useState<"context" | "events">("context");
  const [accessToken, setAccessToken] = useState("");

  useEffect(() => {
    setAccessToken(identity.accessToken);
  }, [identity.accessToken]);

  const connected = realtime?.status === "connected";
  const busy = realtime?.status === "connecting" || realtime?.status === "disconnecting";
  const pages = snapshot?.pages ?? [];
  const threads = snapshot?.threads ?? [];
  const projection = snapshot?.compiledContext;
  const directives = snapshot?.orchestration?.directives ?? [];
  const estimatedFullHistoryTokens = Math.ceil(
    pages.reduce((total, page) => total + page.input.transcript.length + (page.output?.transcript.length ?? 0), 0) / 4,
  );
  const projectedTokens = projection?.estimatedTokens ?? 0;
  const savings = estimatedFullHistoryTokens > 0
    ? Math.max(0, Math.round((1 - projectedTokens / estimatedFullHistoryTokens) * 100))
    : 0;

  async function toggleCall() {
    if (connected) await client.disconnect();
    else await client.connect().catch(() => undefined);
  }

  async function seedScenario() {
    setSeeding(true);
    for (const turn of seededTurns) {
      await session.prepareTextTurn(turn.user);
      await session.ingest({
        type: "assistant.transcript.completed",
        text: turn.assistant,
        at: new Date().toISOString(),
      });
    }
    setSeeding(false);
  }

  async function sendText() {
    const next = text.trim();
    if (!next) return;
    setText("");
    if (connected) {
      await client.sendText(next);
    } else {
      await session.prepareTextTurn(next);
      await session.ingest({
        type: "assistant.transcript.completed",
        text: "Local simulation recorded this turn. Connect OpenAI Realtime to receive a live model response.",
        at: new Date().toISOString(),
      });
    }
  }

  function updateNetwork(next: typeof network) {
    setNetwork(next);
    client.updateEnvironment(next);
  }

  function updateAccessToken(value: string) {
    setAccessToken(value);
    if (value) window.sessionStorage.setItem("llmovoice-demo-token", value);
    else window.sessionStorage.removeItem("llmovoice-demo-token");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <div className="brand">llmovoice<span>.js</span></div>
            <div className="tagline">Context orchestration runtime</div>
          </div>
        </div>
        <div className="topbar-center">
          <span className="eyebrow">LIVE LAB</span>
          <span className="session-id">SESSION / {session.sessionId.slice(-8).toUpperCase()}</span>
        </div>
        <div className="status-cluster">
          <span className={`connection-dot ${connected ? "online" : ""}`} />
          <span>{connected ? "Realtime connected" : realtime?.status ?? "idle"}</span>
          {identity.mode === "supabase" ? <button className="ghost-link" onClick={() => void identity.supabase?.auth.signOut()}>Sign out</button> : null}
          <a href="https://github.com/llmovoice/llmovoice-js" target="_blank" rel="noreferrer" className="ghost-link">GitHub ↗</a>
        </div>
      </header>

      <section className="hero-strip">
        <div>
          <p className="kicker">CONTEXT, COMPILED IN REAL TIME</p>
          <h1>Long conversations.<br /><em>Bounded context.</em></h1>
        </div>
        <p className="hero-copy">
          See every turn become a Page, every topic become a Thread, and every model call receive only the context it needs.
        </p>
        <div className="hero-metrics">
          <Metric value={`${pages.length}`} label="Pages" />
          <Metric value={`${threads.length}`} label="Threads" />
          <Metric value={`${savings}%`} label="Context saved" accent />
        </div>
      </section>

      <section className="lab-grid">
        <div className="column primary-column">
          <Panel title="Realtime call" index="01" action={<StatusPill status={realtime?.status ?? "idle"} />}>
            <div className={`voice-stage ${connected ? "active" : ""}`}>
              <div className="voice-orbit">
                <div className="voice-core">
                  <div className="wave-bars" aria-hidden="true">
                    {Array.from({ length: 17 }, (_, index) => (
                      <span key={index} style={{ "--bar": index } as React.CSSProperties} />
                    ))}
                  </div>
                </div>
                <span className="orbit-label top">{realtime?.userSpeaking ? "USER SPEAKING" : "LISTENING"}</span>
                <span className="orbit-label bottom">{realtime?.assistantSpeaking ? "MODEL SPEAKING" : "READY"}</span>
              </div>
              <button className={`call-button ${connected ? "hangup" : ""}`} onClick={toggleCall} disabled={busy}>
                {busy ? "Working…" : connected ? "End call" : "Start live call"}
              </button>
              <button className="mute-button" onClick={() => client.setMuted(!realtime?.muted)} disabled={!connected}>
                {realtime?.muted ? "Unmute" : "Mute"}
              </button>
              {identity.mode === "local" ? <input
                className="access-token-input"
                type="password"
                autoComplete="off"
                value={accessToken}
                onChange={(event) => updateAccessToken(event.target.value)}
                placeholder="Demo access token (required in production)"
                aria-label="Demo access token"
              /> : <p className="authenticated-user" data-testid="authenticated-user">Supabase user · {userId.slice(0, 8)}</p>}
              <p className="privacy-note">Standard API keys stay server-side. Your browser receives a short-lived token; database access is isolated by RLS.</p>
              {realtime?.error ? <div className="error-banner">{realtime.error}</div> : null}
            </div>
          </Panel>

          <Panel title="Conversation" index="02" action={<span className="micro-copy">voice + text</span>}>
            <div className="transcript-list">
              {pages.length === 0 ? (
                <EmptyState title="No turns yet" copy="Start a live call, type a message, or load the scenario." />
              ) : pages.slice().reverse().slice(0, 8).map((page) => <TranscriptPage key={page.id} page={page} />)}
            </div>
            <div className="composer">
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void sendText(); }}
                placeholder="Send a text turn into the same context…"
              />
              <button onClick={sendText} aria-label="Send text">↗</button>
            </div>
            <button className="scenario-button" onClick={seedScenario} disabled={seeding || pages.length > 0}>
              {seeding ? "Loading scenario…" : "Load topic-switch scenario"}
            </button>
          </Panel>
        </div>

        <div className="column context-column">
          <Panel title="Context graph" index="03" action={<span className="live-indicator">LIVE MAP</span>}>
            <div className="thread-stack">
              {threads.length === 0 ? (
                <EmptyState title="No context graph" copy="Threads appear as the conversation changes topic." />
              ) : threads.map((thread, index) => (
                <ThreadCard key={thread.id} thread={thread} pages={pages} index={index} onArchive={() => void session.archiveThread(thread.id)} />
              ))}
            </div>
          </Panel>

          <Panel
            title="Context compiler"
            index="04"
            action={
              <div className="segmented">
                <button className={activePanel === "context" ? "selected" : ""} onClick={() => setActivePanel("context")}>Projection</button>
                <button className={activePanel === "events" ? "selected" : ""} onClick={() => setActivePanel("events")}>Trace</button>
              </div>
            }
          >
            {activePanel === "context" ? (
              <>
                <div className="budget-row">
                  <div><span>Input budget</span><strong>{projection?.trace.inputBudget.toLocaleString() ?? "2,400"}</strong></div>
                  <div><span>Projected</span><strong>{projectedTokens.toLocaleString()}</strong></div>
                  <div><span>Est. cost</span><strong>{formatMoney(projection?.estimatedCostUsd ?? 0)}</strong></div>
                </div>
                <div className="budget-track"><span style={{ width: `${Math.min(100, projectedTokens / (projection?.trace.inputBudget || 2400) * 100)}%` }} /></div>
                <div className="projection-list">
                  {projection?.items.length ? projection.items.map((item) => (
                    <div className="projection-item" key={`${item.unitKind}-${item.unitId}`}>
                      <span className={`fidelity-dot ${fidelityTone(item.fidelity)}`} />
                      <div className="projection-main">
                        <strong>{item.unitKind.toUpperCase()} / {shortId(item.unitId)}</strong>
                        <span>{item.reasons[0]} · relevance {item.relevance.toFixed(2)}</span>
                      </div>
                      <span className={`fidelity-chip ${fidelityTone(item.fidelity)}`}>{item.fidelity}</span>
                      <strong className="token-count">{item.estimatedTokens}t</strong>
                    </div>
                  )) : <EmptyState title="Nothing compiled" copy="The latest turn's projection will appear here." />}
                </div>
              </>
            ) : (
              <div className="trace-list">
                {(snapshot?.traces ?? []).slice().reverse().slice(0, 14).map((trace) => (
                  <div className="trace-item" key={trace.id}>
                    <span>{new Date(trace.at).toLocaleTimeString([], { hour12: false })}</span>
                    <strong>{trace.type}</strong>
                    <code>{trace.pageId ? shortId(trace.pageId) : "runtime"}</code>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="column runtime-column">
          <Panel title="Runtime state" index="05" action={<span className="version">POLICY v1</span>}>
            <div className="state-grid">
              <StateCell label="Connection" value={snapshot?.state.environment.connection ?? "stable"} tone={snapshot?.state.environment.connection === "degraded" ? "amber" : "green"} />
              <StateCell label="Latency" value={`${snapshot?.state.environment.latencyMs ?? network.latencyMs} ms`} />
              <StateCell label="Jitter" value={`${snapshot?.state.environment.jitterMs ?? network.jitterMs} ms`} />
              <StateCell label="Packet loss" value={`${Math.round((snapshot?.state.environment.packetLoss ?? network.packetLoss) * 100)}%`} />
              <StateCell label="RTT" value={`${snapshot?.state.environment.roundTripTimeMs ?? "—"}${snapshot?.state.environment.roundTripTimeMs ? " ms" : ""}`} />
              <StateCell label="Uplink" value={`${snapshot?.state.environment.availableOutgoingBitrateKbps ?? "—"}${snapshot?.state.environment.availableOutgoingBitrateKbps ? " kbps" : ""}`} />
              <StateCell label="Connect setup" value={realtime?.performance.connectionSetupMs === null || realtime?.performance.connectionSetupMs === undefined ? "—" : `${realtime.performance.connectionSetupMs.toFixed(0)} ms`} />
              <StateCell label="Turn prepare" value={realtime?.performance.lastTurnPreparationMs === null || realtime?.performance.lastTurnPreparationMs === undefined ? "—" : `${realtime.performance.lastTurnPreparationMs.toFixed(0)} ms`} />
              <StateCell label="First audio" value={realtime?.performance.firstAudioLatencyMs === null || realtime?.performance.firstAudioLatencyMs === undefined ? "—" : `${realtime.performance.firstAudioLatencyMs.toFixed(0)} ms`} />
              <StateCell label="Reconnects" value={`${realtime?.performance.reconnectAttempts ?? 0}`} tone={(realtime?.performance.reconnectAttempts ?? 0) > 0 ? "amber" : "green"} />
            </div>
            <div className="state-summary">
              <span>CONTENT <strong>{snapshot?.state.content.intent ?? "observing"}</strong></span>
              <span>STYLE <strong>{snapshot?.state.style.tone ?? "neutral"}{snapshot?.state.style.userWpm ? ` · ${snapshot.state.style.userWpm} WPM` : ""}</strong></span>
              <span>TOPICS <strong>{snapshot?.state.content.topics.slice(-3).join(" · ") || "—"}</strong></span>
            </div>
            <h3 className="subhead">Directives</h3>
            <div className="directive-list">
              {directives.length ? directives.slice(0, 6).map((directive, index) => (
                <DirectiveRow directive={directive} key={`${directive.type}-${index}`} />
              )) : <p className="quiet">Waiting for the first compiled turn.</p>}
            </div>
          </Panel>

          <Panel title="Network mixer" index="06" action={<span className="simulated-badge">SIMULATED OVERRIDE</span>}>
            <NetworkSlider label="Latency" value={network.latencyMs} max={900} unit="ms" onChange={(value) => updateNetwork({ ...network, latencyMs: value })} />
            <NetworkSlider label="Jitter" value={network.jitterMs} max={500} unit="ms" onChange={(value) => updateNetwork({ ...network, jitterMs: value })} />
            <NetworkSlider label="Packet loss" value={Math.round(network.packetLoss * 100)} max={25} unit="%" onChange={(value) => updateNetwork({ ...network, packetLoss: value / 100 })} />
            <div className="preset-row">
              <button onClick={() => updateNetwork({ latencyMs: 45, jitterMs: 8, packetLoss: 0 })}>Stable</button>
              <button onClick={() => updateNetwork({ latencyMs: 280, jitterMs: 90, packetLoss: 0.03 })}>4G</button>
              <button onClick={() => updateNetwork({ latencyMs: 650, jitterMs: 260, packetLoss: 0.1 })}>Volatile</button>
            </div>
          </Panel>

          <Panel title="Cost envelope" index="07">
            <div className="cost-comparison">
              <div>
                <span>Full history</span>
                <strong>{estimatedFullHistoryTokens.toLocaleString()}t</strong>
                <div className="cost-bar baseline"><span style={{ width: "100%" }} /></div>
              </div>
              <div>
                <span>llmovoice projection</span>
                <strong>{projectedTokens.toLocaleString()}t</strong>
                <div className="cost-bar optimized"><span style={{ width: `${estimatedFullHistoryTokens ? Math.max(3, projectedTokens / estimatedFullHistoryTokens * 100) : 0}%` }} /></div>
              </div>
            </div>
            <div className="savings-callout"><strong>{savings}%</strong><span>less historical context this turn</span></div>
            <p className="quiet">Observed provider usage: {(snapshot?.usage.inputTokens ?? 0).toLocaleString()} input / {(snapshot?.usage.outputTokens ?? 0).toLocaleString()} output tokens.</p>
          </Panel>
        </div>
      </section>

      <footer>
        <span>llmovoice.js / open-source realtime context runtime</span>
        <span>{runtime.constructor.name} · {realtime?.rawEventCount ?? 0} provider events</span>
      </footer>
    </main>
  );
}

function AuthStatus({ message }: { message: string }) {
  return <main className="auth-shell"><div className="auth-card"><span className="eyebrow">LLMOVOICE LIVE LAB</span><h1>{message}</h1></div></main>;
}

function SupabaseLogin({ supabase }: { supabase: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const result = mode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (mode === "signup" && !result.data.session) setMessage("Check your email to confirm the account, then sign in.");
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit} data-testid="supabase-auth-form">
        <span className="eyebrow">AUTHENTICATED PRODUCTION PATH</span>
        <h1>Open your persistent voice context.</h1>
        <p>Supabase Auth binds Pages, Threads, traces, and CoachGPT context to one user.</p>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <button type="button" className="auth-mode" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
        {message ? <div className="error-banner" role="status">{message}</div> : null}
      </form>
    </main>
  );
}

function Panel({ title, index, action, children }: { title: string; index: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div><span>{index}</span><h2>{title}</h2></div>
        {action}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function Metric({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return <div className={accent ? "metric accent" : "metric"}><strong>{value}</strong><span>{label}</span></div>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{status.toUpperCase()}</span>;
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><strong>{title}</strong><span>{copy}</span></div>;
}

function TranscriptPage({ page }: { page: VoicePage }) {
  return (
    <article className="transcript-page">
      <div className="turn user-turn"><span>YOU</span><p>{page.input.transcript}</p></div>
      {page.output ? <div className="turn model-turn"><span>MODEL</span><p>{page.output.transcript}</p></div> : <div className="turn model-turn pending"><span>MODEL</span><p>Waiting for response…</p></div>}
      <div className="page-meta"><span>PAGE {page.sequence.toString().padStart(2, "0")}</span><span>{page.threadIds.length} thread link{page.threadIds.length === 1 ? "" : "s"}</span><span>{page.status}</span></div>
    </article>
  );
}

function ThreadCard({ thread, pages, index, onArchive }: { thread: VoiceThread; pages: VoicePage[]; index: number; onArchive: () => void }) {
  const linked = thread.pageIds.map((id) => pages.find((page) => page.id === id)).filter(Boolean) as VoicePage[];
  return (
    <article className={`thread-card ${thread.status}`}>
      <div className="thread-line"><span style={{ "--thread": index } as React.CSSProperties} /></div>
      <div className="thread-content">
        <div className="thread-heading">
          <div><span>THREAD {String(index + 1).padStart(2, "0")}</span><strong>{thread.title}</strong></div>
          <span className={`thread-status ${thread.status}`}>{thread.status}</span>
          {thread.status !== "archived" ? <button className="archive-button" onClick={onArchive}>Archive</button> : null}
        </div>
        <p>{thread.summary}</p>
        <div className="page-chips">
          {linked.map((page) => <span key={page.id}>P{page.sequence}</span>)}
        </div>
      </div>
    </article>
  );
}

function StateCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="state-cell"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function DirectiveRow({ directive }: { directive: Directive }) {
  let value = "active";
  if (directive.type === "turn.setSilence") value = `${directive.milliseconds}ms`;
  if (directive.type === "voice.setPace") value = `${directive.rate.toFixed(2)}×`;
  if (directive.type === "context.activateThread") value = shortId(directive.threadId);
  if (directive.type === "model.instruct") value = "context";
  return <div className="directive-row"><span className="command">{directive.type}</span><strong>{value}</strong><span className="directive-reason">{directive.reason}</span></div>;
}

function NetworkSlider({ label, value, max, unit, onChange }: { label: string; value: number; max: number; unit: string; onChange: (value: number) => void }) {
  return (
    <label className="network-slider">
      <span>{label}<strong>{value}{unit}</strong></span>
      <input type="range" min="0" max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}
