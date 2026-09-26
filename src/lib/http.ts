import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError, badRequest, forbidden } from "./errors";
import { env } from "./env";
import { logger } from "./logger";
import { randomToken } from "./crypto";

/**
 * 모든 API Route Handler를 감싸는 공통 래퍼.
 *  1) 상태 변경 요청(POST/PUT/PATCH/DELETE)에 대해 CSRF(Origin) 검사
 *  2) AppError → 사용자 친화적 메시지로 변환
 *  3) 예상하지 못한 에러 → 서버 로그에는 상세 정보, 사용자에게는 일반 메시지만 반환
 */
type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

export function api<C = unknown>(handler: Handler<C>, opts: { fallbackMessage?: string } = {}): Handler<C> {
  return async (req, ctx) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err, req, opts.fallbackMessage);
    }
  };
}

export function errorResponse(err: unknown, req?: Request, fallbackMessage?: string): Response {
  if (err instanceof AppError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return NextResponse.json(
      { error: first?.message && !first.message.startsWith("Invalid") ? first.message : "입력값을 확인해주세요.", code: "VALIDATION" },
      { status: 400 },
    );
  }
  const errorId = randomToken(6);
  logger.error("Unhandled API error", {
    errorId,
    method: req?.method,
    path: req ? new URL(req.url).pathname : undefined,
    err,
  });
  return NextResponse.json(
    { error: fallbackMessage ?? "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.", code: "INTERNAL", errorId },
    { status: 500 },
  );
}

/**
 * CSRF 방어.
 * 세션 쿠키는 SameSite=Lax 로 설정되어 대부분의 교차 사이트 요청에 전송되지 않지만,
 * 이중 방어로 상태 변경 요청의 Origin(또는 Referer) 헤더가 우리 서비스와 같은지 검사한다.
 * 브라우저는 Origin 헤더를 위조할 수 없으므로 교차 사이트 요청을 확실히 차단할 수 있다.
 */
export function assertSameOrigin(req: Request) {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw forbidden("허용되지 않은 요청입니다.");
  }
  const origin = req.headers.get("origin") ?? refererOrigin(req.headers.get("referer"));
  if (!origin) throw forbidden("허용되지 않은 요청입니다.");
  const allowed = new Set<string>([new URL(env().APP_URL).origin]);
  // 프록시 헤더(X-Forwarded-*)는 신뢰할 수 있는 프록시 뒤에 있을 때(TRUST_PROXY)만 사용한다.
  const trust = env().TRUST_PROXY;
  const host = (trust && req.headers.get("x-forwarded-host")) || req.headers.get("host");
  if (host) {
    const proto = (trust && req.headers.get("x-forwarded-proto")) || new URL(req.url).protocol.replace(":", "");
    allowed.add(`${proto}://${host}`);
  }
  if (!allowed.has(origin)) throw forbidden("허용되지 않은 요청입니다.");
}

function refererOrigin(referer: string | null) {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/** Rate limit 키 등에 사용하는 클라이언트 IP. 프록시 뒤에 있을 때만 X-Forwarded-For를 신뢰한다. */
export function clientIp(req: Request): string {
  if (env().TRUST_PROXY) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real;
  }
  return req.headers.get("x-real-ip") ?? "local";
}

export async function parseJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > 100_000) throw badRequest("요청이 너무 큽니다.");
    body = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw badRequest("요청 형식이 올바르지 않습니다.");
  }
  return schema.parse(body);
}

export function parseQuery<T>(req: NextRequest, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams));
}

export const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, init);
