/**
 * 로그인 후 이동할 경로 검증 (Open Redirect 방지).
 * 같은 사이트의 상대 경로만 허용한다. "//evil.com", "/\evil.com" 같은 우회도 차단한다.
 */
export function safeNextPath(next: string | undefined | null, fallback = "/") {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
