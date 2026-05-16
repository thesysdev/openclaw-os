// Protocol frame types matching OpenClaw gateway protocol v3.
// Defined locally to avoid bundling the server-only `openclaw` package.
// Source of truth: https://github.com/openclaw/openclaw/blob/main/src/gateway/protocol/client-info.ts
// Schema definitions: https://github.com/openclaw/openclaw/blob/main/src/gateway/protocol/schema/

// Copied from src/gateway/protocol/client-info.ts — no subpath export exists for this.
export const GATEWAY_CLIENT_IDS = {
  WEBCHAT_UI: "webchat-ui",
  CONTROL_UI: "openclaw-control-ui",
  TUI: "openclaw-tui",
  WEBCHAT: "webchat",
  CLI: "cli",
  GATEWAY_CLIENT: "gateway-client",
  MACOS_APP: "openclaw-macos",
  IOS_APP: "openclaw-ios",
  ANDROID_APP: "openclaw-android",
  NODE_HOST: "node-host",
  TEST: "test",
  FINGERPRINT: "fingerprint",
  PROBE: "openclaw-probe",
} as const;

export type GatewayClientId = (typeof GATEWAY_CLIENT_IDS)[keyof typeof GATEWAY_CLIENT_IDS];

export const GATEWAY_CLIENT_MODES = {
  WEBCHAT: "webchat",
  CLI: "cli",
  UI: "ui",
  BACKEND: "backend",
  NODE: "node",
  PROBE: "probe",
  TEST: "test",
} as const;

export type GatewayClientMode = (typeof GATEWAY_CLIENT_MODES)[keyof typeof GATEWAY_CLIENT_MODES];

// Client capabilities for opt-in event subscriptions.
// Source: src/gateway/protocol/client-info.ts
// Note: "thinking-events" is in an open PR (#54821) and not yet merged to main.
export const GATEWAY_CLIENT_CAPS = {
  TOOL_EVENTS: "tool-events",
  THINKING_EVENTS: "thinking-events",
} as const;

export type GatewayClientCap = (typeof GATEWAY_CLIENT_CAPS)[keyof typeof GATEWAY_CLIENT_CAPS];

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
}

export interface GatewayErrorDetails {
  code?: string;
  reason?: string;
  requestId?: string;
  canRetryWithDeviceToken?: boolean;
  /** retry_with_device_token | update_auth_configuration | update_auth_credentials | wait_then_retry | review_auth_configuration */
  recommendedNextStep?: string;
}

export interface GatewayError {
  message?: string;
  details?: GatewayErrorDetails;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string | GatewayError;
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: number;
}

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export interface ConnectChallenge {
  nonce: string;
  ts: number;
}

export interface ConnectParams {
  minProtocol?: number;
  maxProtocol?: number;
  /** Opt-in event capability subscriptions (e.g. "tool-events", "thinking-events"). */
  caps?: string[];
  client?: {
    id: GatewayClientId;
    version?: string;
    platform?: string;
    mode?: GatewayClientMode;
    displayName?: string;
    instanceId?: string;
  };
  role?: string;
  scopes?: string[];
  auth?: {
    token?: string;
    deviceToken?: string;
  };
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  locale?: string;
  userAgent?: string;
}

export interface HelloOk {
  protocol: number;
  auth?: {
    deviceToken?: string;
  };
  features?: Record<string, unknown>;
}

// Normalized token usage returned on chat.final events.
// Field names are normalized by the gateway (see normalizeUsage in OpenClaw source).
export interface ChatUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

// event:chat payload — run lifecycle
export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  usage?: ChatUsage;
  stopReason?: string;
}

// Typed data shapes for each event:agent stream variant
export interface AssistantStreamData {
  /** Incremental new tokens. On a `replace` event this is the full new text. */
  delta: string;
  /** Cumulative assistant text so far (authoritative on `replace`). */
  text?: string;
  /**
   * Set by the v4 gateway when the new cumulative text does NOT extend the
   * previously streamed text (a rewrite, e.g. a heartbeat placeholder being
   * swapped for the real answer). Consumers must discard prior streamed text
   * rather than append.
   */
  replace?: boolean;
}

export interface ThinkingStreamData {
  delta: string;
  text?: string;
}

export interface ToolStartData {
  phase: "start";
  name: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

export interface ToolResultData {
  phase: "result";
  name: string;
  toolCallId: string;
  result?: unknown;
  isError: boolean;
  durationMs?: number;
}

export type ToolStreamData = ToolStartData | ToolResultData;

// event:agent payload — discriminated union on `stream`.
// The upstream protocol schema types data as Record<string,unknown>; we narrow
// it per stream so the mapper never needs `as` casts.
interface AgentEventBase {
  runId: string;
  seq: number;
  ts: number;
  sessionKey?: string;
}

export interface AssistantAgentEvent extends AgentEventBase {
  stream: "assistant";
  data: AssistantStreamData;
}

export interface ThinkingAgentEvent extends AgentEventBase {
  stream: "thinking";
  data: ThinkingStreamData;
}

export interface ToolAgentEvent extends AgentEventBase {
  stream: "tool";
  data: ToolStreamData;
}

export interface LifecycleStreamData {
  phase: "error" | "started" | "completed";
  error?: string;
  livenessState?: string;
  endedAt?: number;
}

export interface LifecycleAgentEvent extends AgentEventBase {
  stream: "lifecycle";
  data: LifecycleStreamData;
}

export interface OtherAgentEvent extends AgentEventBase {
  stream: string;
  data: Record<string, unknown>;
}

export type AgentEvent =
  | AssistantAgentEvent
  | ThinkingAgentEvent
  | ToolAgentEvent
  | LifecycleAgentEvent
  | OtherAgentEvent;

// Tool call shape as returned by chat.history on assistant messages
export interface ChatHistoryToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// Message shape returned by chat.history
export interface ChatHistoryMessage {
  id?: string;
  role?: string;
  content?: unknown;
  tool_calls?: ChatHistoryToolCall[];
  tool_call_id?: string;
  error?: string;
  stopReason?: string;
  errorMessage?: string;
  __openclaw?: { id: string; seq: number; kind?: string };
}

export const ConnectionState = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  AUTH_FAILED: "AUTH_FAILED",
  PAIRING: "PAIRING",
  UNREACHABLE: "UNREACHABLE",
} as const;

export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];
