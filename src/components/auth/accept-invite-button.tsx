"use client";

import { useState } from "react";
import { apiFetch, errorMessage, hardNavigate } from "@/lib/client-api";

export function AcceptInviteButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn-primary w-full py-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiFetch("/api/invitations/accept", { json: { token } });
            hardNavigate("/");
          } catch (err) {
            setError(errorMessage(err));
            setBusy(false);
          }
        }}
      >
        {busy ? "참여하는 중…" : "가족 사진첩 참여하기"}
      </button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </>
  );
}
