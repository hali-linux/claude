"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { formatDate } from "@/lib/format";
import { ConfirmDialog } from "../confirm-dialog";
import { useToast } from "../toast";

interface Member {
  userId: string;
  name: string;
  email: string;
  role: "ADMIN" | "MEMBER";
  joinedAt: string;
}

export function AdminMembers({ familyId, members, currentUserId }: { familyId: string; members: Member[]; currentUserId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  const changeRole = async (m: Member, role: Member["role"]) => {
    try {
      await apiFetch(`/api/families/${familyId}/members/${m.userId}`, { method: "PATCH", json: { role } });
      toast(`${m.name}님의 역할을 변경했어요`, "success");
      router.refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
      router.refresh();
    }
  };

  return (
    <>
      <ul className="card divide-y divide-stone-100">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {m.name} {m.userId === currentUserId && <span className="text-xs font-normal text-stone-400">(나)</span>}
              </p>
              <p className="truncate text-xs text-stone-500">
                {m.email} · {formatDate(m.joinedAt)} 참여
              </p>
            </div>
            <select
              className="input w-auto py-1.5"
              value={m.role}
              onChange={(e) => changeRole(m, e.target.value as Member["role"])}
              aria-label={`${m.name} 역할`}
            >
              <option value="ADMIN">관리자</option>
              <option value="MEMBER">구성원</option>
            </select>
            {m.userId !== currentUserId && (
              <button type="button" className="btn-ghost px-3 py-1.5 text-red-600" onClick={() => setRemoving(m)}>
                제거
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={!!removing}
        title={`${removing?.name}님을 가족에서 제거하시겠습니까?`}
        description="제거된 구성원은 더 이상 가족 사진을 볼 수 없어요. 이미 올린 사진은 남아 있습니다."
        confirmLabel="제거"
        danger
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try {
            await apiFetch(`/api/families/${familyId}/members/${removing.userId}`, { method: "DELETE" });
            toast("구성원을 제거했어요", "success");
            setRemoving(null);
            router.refresh();
          } catch (err) {
            toast(errorMessage(err), "error");
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
