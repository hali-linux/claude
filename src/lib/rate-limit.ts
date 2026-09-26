import "server-only";
import { tooManyRequests } from "./errors";

/**
 * 고정 윈도우 방식의 인메모리 Rate Limiter.
 *
 * 단일 서버(또는 Docker 1대) 운영에는 충분하다. 여러 인스턴스로 수평 확장할 경우
 * 인스턴스별로 카운트가 분리되므로 Redis(예: @upstash/ratelimit) 기반 구현으로
 * 교체해야 한다. `RateLimitStore` 인터페이스만 맞추면 호출부는 그대로 사용할 수 있다.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): { count: number; resetAt: number };
  reset(key: string): void;
}

class MemoryStore implements RateLimitStore {
  private map = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  hit(key: string, windowMs: number) {
    const now = Date.now();
    this.sweep(now);
    const cur = this.map.get(key);
    if (!cur || cur.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.map.set(key, fresh);
      return fresh;
    }
    cur.count += 1;
    return cur;
  }

  reset(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  // 메모리 누수 방지를 위해 만료된 키를 주기적으로 정리
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.map) if (v.resetAt <= now) this.map.delete(k);
  }
}

const g = globalThis as unknown as { __rateLimitStore?: MemoryStore };
const store = (g.__rateLimitStore ??= new MemoryStore());

export interface LimitRule {
  /** 윈도우당 허용 횟수 */
  limit: number;
  windowMs: number;
}

export const RULES = {
  login: { limit: 10, windowMs: 15 * 60_000 },
  register: { limit: 10, windowMs: 60 * 60_000 },
  passwordChange: { limit: 10, windowMs: 15 * 60_000 },
  upload: { limit: 600, windowMs: 10 * 60_000 },
  invite: { limit: 30, windowMs: 60 * 60_000 },
  inviteAccept: { limit: 20, windowMs: 15 * 60_000 },
  zip: { limit: 10, windowMs: 10 * 60_000 },
  mutation: { limit: 300, windowMs: 60_000 },
} satisfies Record<string, LimitRule>;

/** 제한 초과 시 429 AppError를 던진다. */
export function rateLimit(key: string, rule: LimitRule) {
  if (process.env.DISABLE_RATE_LIMIT === "1") return;
  const { count } = store.hit(key, rule.windowMs);
  if (count > rule.limit) throw tooManyRequests();
}

export function resetRateLimit(key: string) {
  store.reset(key);
}

export function clearAllRateLimits() {
  store.clear();
}
