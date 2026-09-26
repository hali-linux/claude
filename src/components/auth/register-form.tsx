"use client";

import { useState } from "react";
import { apiFetch, errorMessage, hardNavigate } from "@/lib/client-api";

export function RegisterForm({
  inviteToken,
  inviteEmail,
  askFamilyName,
}: {
  inviteToken?: string;
  inviteEmail?: string;
  askFamilyName: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        if (fd.get("password") !== fd.get("password2")) {
          setError("비밀번호가 서로 일치하지 않습니다.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await apiFetch("/api/auth/register", {
            json: {
              name: fd.get("name"),
              email: inviteEmail ?? fd.get("email"),
              password: fd.get("password"),
              familyName: askFamilyName ? fd.get("familyName") || undefined : undefined,
              inviteToken,
            },
          });
          hardNavigate("/");
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="name" className="label">이름 (가족에게 보여질 이름)</label>
        <input id="name" name="name" required maxLength={50} className="input" placeholder="예: 엄마, 큰아들, 김민수" autoComplete="nickname" />
      </div>
      <div>
        <label htmlFor="email" className="label">이메일</label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="input disabled:bg-stone-100"
          autoComplete="email"
          defaultValue={inviteEmail}
          disabled={!!inviteEmail}
        />
      </div>
      <div>
        <label htmlFor="password" className="label">비밀번호</label>
        <input id="password" name="password" type="password" required minLength={8} maxLength={72} className="input" autoComplete="new-password" />
        <p className="mt-1 text-xs text-stone-500">8자 이상, 영문과 숫자를 포함해주세요.</p>
      </div>
      <div>
        <label htmlFor="password2" className="label">비밀번호 확인</label>
        <input id="password2" name="password2" type="password" required className="input" autoComplete="new-password" />
      </div>
      {askFamilyName && (
        <div>
          <label htmlFor="familyName" className="label">가족 이름</label>
          <input id="familyName" name="familyName" maxLength={50} className="input" placeholder="예: 우리 가족" />
        </div>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
        {busy ? "가입 중…" : inviteToken ? "가입하고 가족과 함께하기" : "가입하기"}
      </button>
    </form>
  );
}
