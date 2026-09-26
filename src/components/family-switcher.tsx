"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { useToast } from "./toast";

export interface FamilyOption {
  id: string;
  name: string;
}

export function FamilySwitcher({
  families,
  currentFamilyId,
  compact,
}: {
  families: FamilyOption[];
  currentFamilyId: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const current = families.find((f) => f.id === currentFamilyId);

  if (families.length <= 1) {
    return (
      <div className={compact ? "truncate text-lg font-bold text-stone-900" : "rounded-xl bg-brand-50 px-3 py-2.5"}>
        {!compact && <p className="text-xs text-brand-700">우리 가족</p>}
        <p className={compact ? "" : "truncate font-semibold text-stone-900"}>{compact ? `📸 ${current?.name}` : current?.name}</p>
      </div>
    );
  }

  return (
    <label className={compact ? "min-w-0 flex-1" : "block"}>
      <span className="sr-only">가족 선택</span>
      <select
        value={currentFamilyId}
        disabled={pending}
        onChange={(e) => {
          const familyId = e.target.value;
          start(async () => {
            try {
              await apiFetch("/api/families/current", { json: { familyId } });
              router.refresh();
            } catch (err) {
              toast(errorMessage(err), "error");
            }
          });
        }}
        className={
          compact
            ? "max-w-full truncate rounded-lg bg-transparent py-1 pr-6 text-lg font-bold text-stone-900 outline-none"
            : "input font-semibold"
        }
      >
        {families.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}
