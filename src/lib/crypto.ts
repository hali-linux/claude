import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/** URL-safe 무작위 토큰(기본 256bit) */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * 토큰을 DB에 저장하기 위한 HMAC-SHA256 해시.
 * AUTH_SECRET을 키로 사용하므로 DB만 유출되어서는 토큰을 위조/재사용할 수 없다.
 */
export function hashToken(token: string): string {
  return createHmac("sha256", env().AUTH_SECRET).update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
