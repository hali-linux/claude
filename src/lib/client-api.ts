/**
 * 브라우저에서 API를 호출하는 헬퍼.
 * 서버가 돌려준 사용자 친화적 메시지(error)만 사용하고, 네트워크 오류도 한국어 메시지로 바꾼다.
 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T = unknown>(
  url: string,
  opts: { method?: string; json?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
      headers: opts.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("네트워크에 연결할 수 없습니다. 인터넷 연결을 확인해주세요.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
      hardNavigate(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
    throw new ApiClientError(data.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.", res.status, data.code);
  }
  return data as T;
}

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
}

/**
 * 로그인/로그아웃/가족 전환처럼 세션 상태가 바뀐 뒤에는 클라이언트 라우터 캐시를 모두 버리기 위해
 * 의도적으로 전체 페이지를 새로 불러온다.
 */
export function hardNavigate(path: string) {
  window.location.assign(path);
}
