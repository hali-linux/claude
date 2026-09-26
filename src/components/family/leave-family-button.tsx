"use client";

import { useState } from "react";
import { apiFetch, errorMessage, hardNavigate } from "@/lib/client-api";
import { ConfirmDialog } from "../confirm-dialog";
import { useToast } from "../toast";

export function LeaveFamilyButton({ familyId, userId, familyName }: { familyId: string; userId: string; familyName: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <>
      <button type="button" className="btn-ghost text-red-600" onClick={() => setOpen(true)}>
        이 가족에서 나가기
      </button>
      <ConfirmDialog
        open={open}
        title={`'${familyName}'에서 나가시겠습니까?`}
        description="나가면 이 가족의 사진을 더 이상 볼 수 없어요. 내가 올린 사진은 가족 사진첩에 남습니다."
        confirmLabel="나가기"
        danger
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await apiFetch(`/api/families/${familyId}/members/${userId}`, { method: "DELETE" });
            hardNavigate("/");
          } catch (err) {
            toast(errorMessage(err), "error");
            setBusy(false);
          }
        }}
      />
    </>
  );
}
