import { NextResponse } from "next/server";
import { api, clientIp, parseJson } from "@/lib/http";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { createSession, setSessionCookie } from "@/lib/session";
import { registerSchema } from "@/lib/validation";
import { registerUser } from "@/services/auth-service";

export const POST = api(async (req) => {
  rateLimit(`register:${clientIp(req)}`, RULES.register);
  const input = await parseJson(req, registerSchema);
  const user = await registerUser(input);
  const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
  const res = NextResponse.json({ user: { id: user.id, name: user.name, email: user.email } }, { status: 201 });
  setSessionCookie(res, token, expiresAt);
  return res;
}, { fallbackMessage: "회원가입에 실패했습니다. 잠시 후 다시 시도해주세요." });
