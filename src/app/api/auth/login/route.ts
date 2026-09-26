import { NextResponse } from "next/server";
import { api, clientIp, parseJson } from "@/lib/http";
import { rateLimit, resetRateLimit, RULES } from "@/lib/rate-limit";
import { createSession, setSessionCookie } from "@/lib/session";
import { loginSchema } from "@/lib/validation";
import { authenticate } from "@/services/auth-service";

export const POST = api(async (req) => {
  const { email, password } = await parseJson(req, loginSchema);
  // IP 단위 + 계정 단위 두 가지로 제한 → 무차별 대입(Brute force) 공격 방어
  const ip = clientIp(req);
  rateLimit(`login:ip:${ip}`, { limit: RULES.login.limit * 3, windowMs: RULES.login.windowMs });
  const accountKey = `login:acct:${email}`;
  rateLimit(accountKey, RULES.login);
  const user = await authenticate(email, password);
  resetRateLimit(accountKey);
  const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
  const res = NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } });
  setSessionCookie(res, token, expiresAt);
  return res;
}, { fallbackMessage: "로그인에 실패했습니다. 잠시 후 다시 시도해주세요." });
