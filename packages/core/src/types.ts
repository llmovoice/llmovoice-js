export type Modality = "audio" | "text" | "sms";
export type Fidelity = "audio" | "transcript" | "summary" | "drop";
export type ConnectionQuality = "stable" | "degraded" | "offline";
export type ThreadStatus = "active" | "background" | "archived";
export type PageStatus = "open" | "complete" | "interrupted";

export interface AudioRef {
  uri: string;
  durationMs?: number;
  mimeType?: string;
  persisted?: boolean;
  expiresAt?: string;
}

export interface ContentState {
  intent?: string;
  urgency?: number;
  explicitInstructions: string[];
  entities: string[];
  topics: string[];
}

export interface StyleState {
  userWpm?: number;
  agentWpm?: number;
  preferredAgentWpm?: number;
  interruptionPattern?: "frequent" | "normal" | "rare";
  tone?: string;
}

export interface EnvironmentState {
  latencyMs: number;
  jitterMs: number;
  packetLoss: number;
  roundTripTimeMs?: number;
  availableOutgoingBitrateKbps?: number;
  packetsSent?: number;
  packetsLost?: number;
  connection: ConnectionQuality;
  observedAt: string;
}

export interface StateSnapshot<Extensions = Record<string, unknown>> {
  content: ContentState;
  style: StyleState;
  environment: EnvironmentState;
  extensions?: Extensions;
  version: number;
  observedAt: string;
}

export interface PageTurn {
  modality: Modality;
  audio?: AudioRef;
  providerItemId?: string;
  transcript: string;
  startedAt?: string;
  completedAt?: string;
}

export interface VoicePage<Extensions = Record<string, unknown>> {
  id: string;
  userId: string;
  sessionId: string;
  sequence: number;
  status: PageStatus;
  input: PageTurn;
  output?: PageTurn;
  summary: string;
  embedding?: number[];
  state: StateSnapshot<Extensions>;
  availableFidelities: Fidelity[];
  threadIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceThread {
  id: string;
  userId: string;
  title: string;
  summary: string;
  embedding?: number[];
  pageIds: string[];
  status: ThreadStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export interface ExternalContextUnit {
  id: string;
  source: string;
  title?: string;
  content: string;
  summary?: string;
  embedding?: number[];
  sensitivity?: string;
  metadata?: Record<string, unknown>;
  updatedAt?: string;
}

export type ContextUnit =
  | { kind: "page"; value: VoicePage }
  | { kind: "thread"; value: VoiceThread }
  | { kind: "external"; value: ExternalContextUnit };

export interface RetrievedUnit {
  unit: ContextUnit;
  relevance: number;
  reasons: string[];
}

export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  maxCostUsd?: number;
}

export interface TokenCostModel {
  audioTokensPerSecond: number;
  textTokensPerWord: number;
  inputTextUsdPerMillionTokens?: number;
  inputAudioUsdPerMillionTokens?: number;
}

export interface ProjectionItem {
  unitId: string;
  unitKind: ContextUnit["kind"];
  fidelity: Fidelity;
  relevance: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  content: string;
  audio?: AudioRef;
  reasons: string[];
}

export interface ProjectionTrace {
  candidateCount: number;
  selectedCount: number;
  droppedCount: number;
  inputBudget: number;
  usedTokens: number;
  safetyTokens: number;
  durationMs: number;
  decisions: Array<{
    unitId: string;
    selected: Fidelity;
    relevance: number;
    estimatedTokens: number;
    reason: string;
  }>;
}

export interface CompiledContext {
  id: string;
  query: string;
  items: ProjectionItem[];
  rendered: string;
  estimatedTokens: number;
  estimatedCostUsd: number;
  trace: ProjectionTrace;
  createdAt: string;
}

export type CoreDirective =
  | { type: "turn.setSilence"; milliseconds: number; reason: string }
  | { type: "voice.setPace"; rate: number; targetWpm?: number; reason: string }
  | { type: "response.pause"; reason: string }
  | { type: "response.resume"; reason: string }
  | { type: "context.activateThread"; threadId: string; reason: string }
  | { type: "context.archiveThread"; threadId: string; reason: string }
  | { type: "model.instruct"; text: string; reason: string };

export interface ExtensionDirective {
  type: `app.${string}` | `tool.${string}`;
  payload?: unknown;
  reason: string;
}

export type Directive = CoreDirective | ExtensionDirective;

export interface OrchestrationResult {
  directives: Directive[];
  state: StateSnapshot;
  durationMs: number;
  policyVersion: string;
}

export interface OrchestrationProposal {
  directives: Directive[];
  rationale?: string;
}

export type ConversationEvent =
  | { type: "session.connected"; sessionId: string; at: string }
  | { type: "session.disconnected"; sessionId: string; at: string; reason?: string }
  | { type: "user.speech.started"; at: string }
  | { type: "user.speech.stopped"; at: string }
  | { type: "user.transcript.delta"; text: string; at: string }
  | { type: "user.transcript.completed"; text: string; at: string; audio?: AudioRef; providerItemId?: string }
  | { type: "assistant.transcript.delta"; text: string; at: string }
  | { type: "assistant.transcript.completed"; text: string; at: string; audio?: AudioRef; providerItemId?: string }
  | { type: "assistant.audio.started"; at: string }
  | { type: "assistant.audio.stopped"; at: string }
  | { type: "response.usage"; inputTokens: number; outputTokens: number; cachedInputTokens?: number; at: string }
  | { type: "environment.updated"; environment: Partial<EnvironmentState>; at: string; source?: "application" | "webrtc" | "telephony" }
  | { type: "response.interrupted"; at: string };

export interface RuntimeTraceEvent {
  id: string;
  type:
    | "page.created"
    | "page.completed"
    | "thread.spawned"
    | "thread.appended"
    | "thread.archived"
    | "context.compiled"
    | "state.changed"
    | "state.extracted"
    | "directive.emitted"
    | "directive.executed"
    | "telemetry.sampled"
    | "usage.updated"
    | "session.restored"
    | "runtime.fallback";
  at: string;
  userId?: string;
  sessionId: string;
  pageId?: string;
  threadId?: string;
  data: Record<string, unknown>;
}

export interface StoreListOptions {
  limit?: number;
  order?: "asc" | "desc";
  sessionId?: string;
}

export interface AdapterCallOptions {
  signal?: AbortSignal;
}

export interface EnrichmentJob {
  id: string;
  userId: string;
  pageId: string;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt?: string;
  workerId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichmentQueue {
  enqueueEnrichment(job: Pick<EnrichmentJob, "id" | "userId" | "pageId" | "maxAttempts" | "availableAt" | "createdAt" | "updatedAt">): Promise<void>;
  claimEnrichment(input: { userId: string; workerId: string; leaseMs: number }): Promise<EnrichmentJob | null>;
  completeEnrichment(input: { id: string; userId: string; workerId: string; completedAt: string }): Promise<void>;
  failEnrichment(input: { id: string; userId: string; workerId: string; error: string; retryAt: string }): Promise<void>;
}

export interface ContextStore {
  savePage(page: VoicePage): Promise<void>;
  savePages?(pages: VoicePage[]): Promise<void>;
  getPage(id: string, userId?: string): Promise<VoicePage | null>;
  listPages(userId: string, options?: StoreListOptions): Promise<VoicePage[]>;
  saveThread(thread: VoiceThread): Promise<void>;
  saveThreads?(threads: VoiceThread[]): Promise<void>;
  getThread(id: string, userId?: string): Promise<VoiceThread | null>;
  listThreads(userId: string, options?: StoreListOptions): Promise<VoiceThread[]>;
  appendTrace(event: RuntimeTraceEvent): Promise<void>;
  appendTraces?(events: RuntimeTraceEvent[]): Promise<void>;
  listTraces(sessionId: string, userId?: string, options?: StoreListOptions): Promise<RuntimeTraceEvent[]>;
  searchPages?(userId: string, embedding: number[], limit: number): Promise<VoicePage[]>;
  searchThreads?(userId: string, embedding: number[], limit: number): Promise<VoiceThread[]>;
}

export interface EmbeddingAdapter {
  embed(text: string, options?: AdapterCallOptions): Promise<number[]>;
}

export interface SummaryAdapter {
  summarize(text: string, maxWords?: number, options?: AdapterCallOptions): Promise<string>;
}

export interface StateExtractionAdapter {
  extract(input: {
    text: string;
    current: StateSnapshot;
    audio?: AudioRef;
    signal?: AbortSignal;
  }): Promise<Partial<Pick<StateSnapshot, "content" | "style">>>;
}

export interface OrchestrationReasoner {
  reason(input: {
    state: StateSnapshot;
    context: CompiledContext;
    activeThreadIds: string[];
    signal?: AbortSignal;
  }): Promise<OrchestrationProposal>;
}

export interface DirectiveExecutor {
  execute(directive: Directive): void | Promise<void>;
}

export interface ContextSource {
  name: string;
  retrieve(input: {
    userId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ExternalContextUnit[]>;
}

export interface Clock {
  now(): Date;
}
