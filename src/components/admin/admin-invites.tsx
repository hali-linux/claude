"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { useToast } from "../toast";

interface Invitation {
  id: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { name: string } | null;
}

function statusOf(i: Invitation) {
  if (i.acceptedAt) return { label: "참여 완료", cls: "bg-emerald-50 text-emerald-700" };
  if (i.revokedAt) return { label: "취소됨", cls: "bg-stone-100 text-stone-500" };
  if (new Date(i.expiresAt) < new Date()) return { label: "만료됨", cls: "bg-stone-100 text-stone-500" };
  return { label: "대기 중", cls: "bg-amber-50 text-amber-700" };
}

export function AdminInvites({ familyId, invitations, ttlHours }: { familyId: string; invitations: Invitation[]; ttlHours: number }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; email: string; emailSent: boolean } | null>(null);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("초대 링크를 복사했어요", "success");
    } catch {
      toast("복사하지 못했어요. 링크를 길게 눌러 직접 복사해주세요.", "error");
    }
  };

  return (
    <div className="space-y-4">
      <form
        className="card space-y-3 p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const fd = new FormData(form);
          setBusy(true);
          try {
            const res = await apiFetch<{ url: string; emailSent: boolean; invitation: { email: string } }>("/api/invitations", {
              json: { familyId, email: fd.get("email"), role: fd.get("role") },
            });
            setCreated({ url: res.url, email: res.invitation.email, emailSent: res.emailSent });
            form.reset();
            router.refresh();
          } catch (err) {
            toast(errorMessage(err), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="text-sm text-stone-600">
          초대할 가족의 이메일을 입력하세요. 초대 링크는 <b>{ttlHours}시간</b> 동안 <b>한 번만</b> 사용할 수 있고, 해당 이메일로만 가입할 수 있어요.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input name="email" type="email" required className="input flex-1" placeholder="family@example.com" aria-label="초대할 이메일" />
          <select name="role" className="input sm:w-32" defaultValue="MEMBER" aria-label="역할">
            <option value="MEMBER">구성원</option>
            <option value="ADMIN">관리자</option>
          </select>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "만드는 중…" : "초대 링크 만들기"}
          </button>
        </div>
        {created && (
          <div className="rounded-xl bg-brand-50 p-3">
            <p className="text-sm font-semibold text-brand-800">
              {created.email}님을 위한 초대 링크가 만들어졌어요 {created.emailSent && "(이메일로도 보냈어요)"}
            </p>
            <p className="mt-1 text-xs text-brand-700">보안을 위해 이 링크는 지금만 표시됩니다. 카카오톡·문자로 전달해주세요.</p>
            <div className="mt-2 flex gap-2">
              <input readOnly value={created.url} className="input flex-1 bg-white text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="초대 링크" />
              <button type="button" className="btn-primary shrink-0" onClick={() => copy(created.url)}>
                복사
              </button>
            </div>
          </div>
        )}
      </form>

      {invitations.length > 0 && (
        <ul className="card divide-y divide-stone-100">
          {invitations.map((i) => {
            const st = statusOf(i);
            const pending = st.label === "대기 중";
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-3 p-3.5 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{i.email}</p>
                  <p className="text-xs text-stone-500">
                    {i.role === "ADMIN" ? "관리자" : "구성원"} · {formatDateTime(i.createdAt)} 생성 · {formatDateTime(i.expiresAt)} 만료
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${st.cls}`}>{st.label}</span>
                {pending && (
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-red-600"
                    onClick={async () => {
                      try {
                        await apiFetch(`/api/invitations/${i.id}`, { method: "DELETE" });
                        toast("초대를 취소했어요", "success");
                        router.refresh();
                      } catch (err) {
                        toast(errorMessage(err), "error");
                      }
                    }}
                  >
                    취소
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
