"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { useToast } from "../toast";

export function ProfileForm({ name, email }: { name: string; email: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await apiFetch("/api/auth/profile", { method: "PATCH", json: { name: new FormData(e.currentTarget).get("name") } });
          toast("이름을 저장했어요", "success");
          router.refresh();
        } catch (err) {
          toast(errorMessage(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor="email-ro">이메일</label>
        <input id="email-ro" className="input bg-stone-100" value={email} disabled />
      </div>
      <div>
        <label className="label" htmlFor="profile-name">이름</label>
        <input id="profile-name" name="name" required maxLength={50} defaultValue={name} className="input" />
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>저장</button>
    </form>
  );
}

export function PasswordForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        if (fd.get("newPassword") !== fd.get("newPassword2")) {
          setError("새 비밀번호가 서로 일치하지 않습니다.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await apiFetch("/api/auth/password", {
            method: "PUT",
            json: { currentPassword: fd.get("currentPassword"), newPassword: fd.get("newPassword") },
          });
          form.reset();
          toast("비밀번호를 변경했어요. 다른 기기에서는 다시 로그인해야 해요.", "success");
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor="cur-pw">현재 비밀번호</label>
        <input id="cur-pw" name="currentPassword" type="password" required autoComplete="current-password" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="new-pw">새 비밀번호</label>
        <input id="new-pw" name="newPassword" type="password" required minLength={8} maxLength={72} autoComplete="new-password" className="input" />
        <p className="mt-1 text-xs text-stone-500">8자 이상, 영문과 숫자를 포함해주세요.</p>
      </div>
      <div>
        <label className="label" htmlFor="new-pw2">새 비밀번호 확인</label>
        <input id="new-pw2" name="newPassword2" type="password" required autoComplete="new-password" className="input" />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="btn-primary" disabled={busy}>비밀번호 변경</button>
    </form>
  );
}
