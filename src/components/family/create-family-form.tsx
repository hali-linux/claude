"use client";

import { useState } from "react";
import { apiFetch, errorMessage, hardNavigate } from "@/lib/client-api";

export function CreateFamilyForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setBusy(true);
        setError(null);
        try {
          const res = await apiFetch<{ family: { id: string } }>("/api/families", {
            json: { name: fd.get("name"), description: fd.get("description") || null },
          });
          await apiFetch("/api/families/current", { json: { familyId: res.family.id } });
          hardNavigate("/");
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div>
        <label htmlFor="family-name" className="label">새 가족 이름</label>
        <input id="family-name" name="name" required maxLength={50} className="input" placeholder="예: 외갓집, 우리 가족" />
      </div>
      <div>
        <label htmlFor="family-desc" className="label">소개 (선택)</label>
        <input id="family-desc" name="description" maxLength={500} className="input" />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? "만드는 중…" : "새 가족 사진첩 만들기"}
      </button>
    </form>
  );
}
