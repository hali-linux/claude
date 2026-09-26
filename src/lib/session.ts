import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "./db";
import { env } from "./env";
import { hashToken, randomToken } from "./crypto";
import { unauthorized } from "./errors";
import type { UserRole } from "@/generated/prisma/enums";

/**
 * 세션 기반 인증.
 *
 * 왜 JWT가 아닌 DB 세션인가?
 *  - 로그아웃/비밀번호 변경 시 즉시 세션을 무효화할 수 있다(JWT는 만료 전까지 폐기 불가).
 *  - 가족사진처럼 민감한 데이터를 다루는 서비스에서는 "즉시 폐기"가 더 중요하다.
 *
 * 쿠키 설정
 *  - HttpOnly: JS에서 접근 불가(XSS로 세션 탈취 방지)
 *  - Secure + __Host- 접두사(HTTPS 환경): 하위 도메인/HTTP로의 쿠키 누출 방지
 *  - SameSite=Lax: 교차 사이트 POST 요청에 쿠키가 전송되지 않음(CSRF 1차 방어)
 */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

const RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 하루에 한 번만 만료 시각을 연장(DB 쓰기 최소화)

export function isSecureCookie() {
  return env().APP_URL.startsWith("https://");
}

export function sessionCookieName() {
  return isSecureCookie() ? "__Host-fp_session" : "fp_session";
}

export const FAMILY_COOKIE = "fp_family";

function maxAgeMs() {
  return env().SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

export async function createSession(userId: string, userAgent?: string | null) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + maxAgeMs());
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt, userAgent: userAgent?.slice(0, 255) },
  });
  return { token, expiresAt };
}

export function setSessionCookie(res: NextResponse, token: string, expiresAt: Date) {
  res.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function validateSessionToken(token: string | undefined | null): Promise<{ user: AuthUser; sessionId: string } | null> {
  if (!token || token.length > 128) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  // 슬라이딩 만료: 사용 중인 세션은 자동 연장
  if (now - session.lastUsedAt.getTime() > RENEW_THRESHOLD_MS) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date(now), expiresAt: new Date(now + maxAgeMs()) } })
      .catch(() => {});
  }
  return { user: session.user, sessionId: session.id };
}

export function readSessionToken(req: NextRequest): string | undefined {
  return req.cookies.get(sessionCookieName())?.value;
}

/** Route Handler용: 로그인 사용자 조회(없으면 null) */
export async function getRequestUser(req: NextRequest) {
  return (await validateSessionToken(readSessionToken(req)))?.user ?? null;
}

/** Route Handler용: 로그인 필수 */
export async function requireUser(req: NextRequest): Promise<AuthUser> {
  const user = await getRequestUser(req);
  if (!user) throw unauthorized();
  return user;
}

/** Server Component용: 현재 로그인 사용자 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  return (await validateSessionToken(store.get(sessionCookieName())?.value))?.user ?? null;
}

export async function revokeSessionToken(token: string | undefined) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function revokeOtherSessions(userId: string, keepToken?: string) {
  await prisma.session.deleteMany({
    where: { userId, ...(keepToken ? { NOT: { tokenHash: hashToken(keepToken) } } : {}) },
  });
}
