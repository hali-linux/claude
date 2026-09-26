"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { useToast } from "../toast";

export function FamilyEditor({ family }: { family: { id: string; name: string; description: string | null } }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();

  if (!editing) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
        가족 정보 수정
      </button>
    );
  }
  return (
    <form
      className="card w-full space-y-3 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        try {
          await apiFetch(`/api/families/${family.id}`, { method: "PATCH", json: { name: fd.get("name"), description: fd.get("description") || null } });
          toast("가족 정보를 저장했어요", "success");
          setEditing(false);
          router.refresh();
        } catch (err) {
          toast(errorMessage(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input name="name" required maxLength={50} defaultValue={family.name} className="input" aria-label="가족 이름" />
      <textarea name="description" maxLength={500} defaultValue={family.description ?? ""} className="input" aria-label="가족 소개" placeholder="가족 소개" />
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" onClick={() => setEditing(false)}>취소</button>
        <button type="submit" className="btn-primary" disabled={busy}>저장</button>
      </div>
    </form>
  );
}
