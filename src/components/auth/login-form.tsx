"use client";

import { useState } from "react";
import { apiFetch, errorMessage, hardNavigate } from "@/lib/client-api";

export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        try {
          await apiFetch("/api/auth/login", { json: { email: fd.get("email"), password: fd.get("password") } });
          // 전체 새로고침으로 이동 → 새 세션 쿠키 기준으로 모든 서버 컴포넌트를 다시 렌더링
          hardNavigate(next);
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="email" className="label">이메일</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" inputMode="email" />
      </div>
      <div>
        <label htmlFor="password" className="label">비밀번호</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "로그인 중…" : "로그인"}
      </button>
    </form>
  );
}
