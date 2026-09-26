"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PhotoDTO } from "@/types";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format";
import { ConfirmDialog } from "../confirm-dialog";
import { useToast } from "../toast";

type TrashItem = PhotoDTO & { deletedByName: string | null };

export function AdminTrash({ familyId, items }: { familyId: string; items: TrashItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [target, setTarget] = useState<TrashItem | "all" | null>(null);
  const [busy, setBusy] = useState(false);

  const restore = async (id: string) => {
    try {
      await apiFetch(`/api/photos/${id}/restore`, { method: "POST" });
      toast("사진을 복구했어요", "success");
      router.refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  if (items.length === 0) return <p className="card p-6 text-center text-sm text-stone-500">휴지통이 비어 있어요.</p>;

  return (
    <>
      <div className="flex justify-end">
        <button type="button" className="btn-ghost text-red-600" onClick={() => setTarget("all")}>
          휴지통 비우기
        </button>
      </div>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((p) => (
          <li key={p.id} className="card overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.thumbUrl} alt={p.originalName} loading="lazy" className="aspect-square w-full object-cover opacity-80" />
            <div className="space-y-2 p-2.5">
              <p className="truncate text-xs text-stone-600" title={p.originalName}>{p.originalName}</p>
              <p className="text-[11px] text-stone-400">
                {p.deletedByName ?? "알 수 없음"} · {formatDateTime(p.deletedAt)}
              </p>
              <div className="flex gap-1">
                <button type="button" className="btn-secondary flex-1 px-2 py-1.5 text-xs" onClick={() => restore(p.id)}>
                  복구
                </button>
                <button type="button" className="btn-ghost flex-1 px-2 py-1.5 text-xs text-red-600" onClick={() => setTarget(p)}>
                  영구 삭제
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={target !== null}
        title={target === "all" ? "휴지통을 비우시겠습니까?" : "이 사진을 영구 삭제하시겠습니까?"}
        description="영구 삭제한 사진은 다시 복구할 수 없어요."
        confirmLabel="영구 삭제"
        danger
        busy={busy}
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            if (target === "all") await apiFetch(`/api/families/${familyId}/trash`, { method: "DELETE" });
            else if (target) await apiFetch(`/api/photos/${target.id}?permanent=1`, { method: "DELETE" });
            toast("영구 삭제했어요", "success");
            setTarget(null);
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
