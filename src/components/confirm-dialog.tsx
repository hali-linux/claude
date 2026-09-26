"use client";

import { useEffect, useRef } from "react";

/**
 * 확인창. 삭제 등 되돌리기 어려운 작업 전에 반드시 사용한다.
 * 네이티브 <dialog>를 사용해 포커스 트랩과 ESC 닫기를 브라우저가 처리하도록 한다.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "확인",
  cancelLabel = "취소",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl bg-white p-0 shadow-2xl backdrop:bg-black/50"
    >
      <div className="p-6">
        <h2 className="text-lg font-bold text-stone-900">{title}</h2>
        {description && <div className="mt-2 text-sm text-stone-600">{description}</div>}
        <div className="mt-6 flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`${danger ? "btn-danger" : "btn-primary"} flex-1`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus
          >
            {busy ? "처리 중…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
