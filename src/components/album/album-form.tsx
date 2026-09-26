"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { IconPlus } from "../icons";
import { useToast } from "../toast";

export function AlbumFormDialog({
  open,
  onClose,
  initial,
  onSubmit,
  title,
}: {
  open: boolean;
  onClose: () => void;
  initial?: { name: string; description: string | null };
  onSubmit: (data: { name: string; description: string }) => Promise<void>;
  title: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-black/50"
    >
      <form
        className="space-y-4 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          setBusy(true);
          setError(null);
          try {
            await onSubmit({ name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? "") });
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="text-lg font-bold">{title}</h2>
        <div>
          <label htmlFor="album-name" className="label">앨범 이름</label>
          <input id="album-name" name="name" required maxLength={100} defaultValue={initial?.name} className="input" placeholder="예: 2026년 가족여행" />
        </div>
        <div>
          <label htmlFor="album-desc" className="label">설명 (선택)</label>
          <textarea id="album-desc" name="description" maxLength={1000} defaultValue={initial?.description ?? ""} className="input min-h-24" />
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose} disabled={busy}>취소</button>
          <button type="submit" className="btn-primary flex-1" disabled={busy}>{busy ? "저장 중…" : "저장"}</button>
        </div>
      </form>
    </dialog>
  );
}

export function CreateAlbumButton({ familyId }: { familyId: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        <IconPlus /> 새 앨범
      </button>
      <AlbumFormDialog
        open={open}
        title="새 앨범 만들기"
        onClose={() => setOpen(false)}
        onSubmit={async (data) => {
          const res = await apiFetch<{ album: { id: string } }>("/api/albums", { json: { familyId, ...data } });
          toast("앨범을 만들었어요", "success");
          router.push(`/albums/${res.album.id}`);
        }}
      />
    </>
  );
}
