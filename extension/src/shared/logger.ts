export type LogNamespace = "page" | "agent" | "action" | "voice" | "proactive" | "video" | "character" | "bg" | "offscreen" | "ui" | "session" | "tablet";

const SENSITIVE_KEY = /pass(word)?|token|secret|api[-_]?key|card|cvv|cvc|ssn|otp|auth[-_]?code|pin/i;

let debugEnabled = false;
const listeners = new Set<(entry: LogEntry) => void>();

export interface LogEntry {
  ns: LogNamespace;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: unknown;
  at: number;
}

export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
}

export function onLog(cb: (entry: LogEntry) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Removes obviously sensitive keys before anything is logged. Never log raw form values. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out as T;
}

const COLORS: Record<LogNamespace, string> = {
  page: "#6366f1",
  agent: "#0ea5e9",
  action: "#f59e0b",
  voice: "#10b981",
  proactive: "#ec4899",
  video: "#ef4444",
  character: "#8b5cf6",
  bg: "#64748b",
  offscreen: "#14b8a6",
  ui: "#a855f7",
  session: "#94a3b8",
  tablet: "#0f766e",
};

export function log(ns: LogNamespace) {
  const prefix = `%c[pip:${ns}]`;
  const style = `color:${COLORS[ns]};font-weight:600`;
  const emit = (level: LogEntry["level"], message: string, data?: unknown) => {
    const entry: LogEntry = { ns, level, message, data: data === undefined ? undefined : redact(data), at: Date.now() };
    for (const l of listeners) {
      try {
        l(entry);
      } catch {
        /* ignore */
      }
    }
    if (level === "debug" && !debugEnabled) return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "info" ? console.info : console.debug;
    if (entry.data === undefined) fn(prefix, style, message);
    else fn(prefix, style, message, entry.data);
  };
  return {
    debug: (m: string, data?: unknown) => emit("debug", m, data),
    info: (m: string, data?: unknown) => emit("info", m, data),
    warn: (m: string, data?: unknown) => emit("warn", m, data),
    error: (m: string, data?: unknown) => emit("error", m, data),
  };
}
