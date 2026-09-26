import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (Next.js 16의 Middleware)
 *
 * 1) 페이지 요청마다 nonce 기반 Content-Security-Policy를 설정한다 → XSS 발생 시 피해 최소화
 * 2) 세션 쿠키가 없으면 로그인 페이지로 보내는 "낙관적" 검사를 한다.
 *    실제 인증/권한 검사는 각 페이지와 API에서 DB 세션으로 다시 수행한다(Proxy만 믿지 않음).
 *
 * /api 경로는 matcher에서 제외한다. (Proxy를 거치면 요청 본문이 메모리에 버퍼링되어
 * 대용량 사진 업로드에 불리하며, API는 자체적으로 인증을 검사한다.)
 */
const PUBLIC_PATHS = ["/login", "/register", "/invite"];

function imgSources() {
  const extra: string[] = [];
  if (process.env.STORAGE_DRIVER === "s3") {
    if (process.env.CLOUDFRONT_DOMAIN) extra.push(`https://${process.env.CLOUDFRONT_DOMAIN}`);
    if (process.env.S3_ENDPOINT) extra.push(new URL(process.env.S3_ENDPOINT).origin);
    if (process.env.S3_BUCKET) {
      extra.push(`https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`);
      extra.push(`https://s3.${process.env.AWS_REGION}.amazonaws.com`);
    }
  }
  return extra.join(" ");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const sessionCookie = request.cookies.get("__Host-fp_session") ?? request.cookies.get("fp_session");
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!isPublic && !sessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + search)}` : "";
    return NextResponse.redirect(url);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const isHttps = (process.env.APP_URL ?? "").startsWith("https://");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${imgSources()}`.trim(),
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // HTTPS로 서비스할 때만 HSTS 적용 (브라우저가 이후 항상 HTTPS로 접속)
  if (isHttps) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
