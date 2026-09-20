type Level = "debug" | "info" | "warn" | "error";
const SENSITIVE = /pass(word)?|token|secret|api[-_]?key|card|cvv|ssn|otp|code/i;

export function redact<T>(v: T, depth = 0): T {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(val, depth + 1);
  return out as T;
}

const verbose = process.env.LOG_LEVEL === "debug";

export function log(ns: string) {
  const emit = (level: Level, msg: string, data?: unknown) => {
    if (level === "debug" && !verbose) return;
    const time = new Date().toISOString().slice(11, 23);
    const line = `${time} [${ns}] ${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (data === undefined) fn(line);
    else fn(line, JSON.stringify(redact(data)).slice(0, 600));
  };
  return {
    debug: (m: string, d?: unknown) => emit("debug", m, d),
    info: (m: string, d?: unknown) => emit("info", m, d),
    warn: (m: string, d?: unknown) => emit("warn", m, d),
    error: (m: string, d?: unknown) => emit("error", m, d),
  };
}
