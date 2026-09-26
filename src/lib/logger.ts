import "server-only";

/**
 * 간단한 구조화 로거.
 * 비밀번호, 토큰, 쿠키 등 민감한 키는 자동으로 마스킹하여 로그에 남지 않도록 한다.
 * 운영환경에서는 JSON 한 줄 형식으로 출력하여 CloudWatch 등에서 검색하기 쉽게 한다.
 */
const SENSITIVE = /pass(word)?|secret|token|cookie|authorization|session|hash|key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && level !== "error" && !process.env.DEBUG_LOGS) return;
  if (process.env.NODE_ENV === "test" && process.env.SILENCE_ERROR_LOGS) return;
  const entry = { level, time: new Date().toISOString(), msg, ...(meta ? (redact(meta) as object) : {}) };
  const line = process.env.NODE_ENV === "production" ? JSON.stringify(entry) : entry;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};

export const __test = { redact };
