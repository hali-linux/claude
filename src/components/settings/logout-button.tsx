"use client";

import { useState } from "react";
import { hardNavigate } from "@/lib/client-api";

export function LogoutButton({ className = "btn-ghost" }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        hardNavigate("/login");
      }}
    >
      {busy ? "로그아웃 중…" : "로그아웃"}
    </button>
  );
}
