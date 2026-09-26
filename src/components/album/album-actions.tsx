"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AlbumDTO } from "@/types";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { ConfirmDialog } from "../confirm-dialog";
import { IconDownload } from "../icons";
import { useToast } from "../toast";
import { AlbumFormDialog } from "./album-form";

export function AlbumActions({ album, canAdmin, zipParts, perPart }: { album: AlbumDTO; canAdmin: boolean; zipParts: number; perPart: number }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletePhotos, setDeletePhotos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);

  return (
    <>
      {album.photoCount > 0 &&
        (zipParts === 1 ? (
          <a href={`/api/albums/${album.id}/download`} className="btn-secondary">
            <IconDownload /> 전체 다운로드
          </a>
        ) : (
          <div className="relative">
            <button type="button" className="btn-secondary" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
              <IconDownload /> 전체 다운로드 ({zipParts}개 파일)
            </button>
            {menu && (
              <div className="card absolute right-0 z-20 mt-2 w-60 p-2">
                <p className="px-2 pb-2 text-xs text-stone-500">사진이 많아 {perPart}장씩 나누어 받아요.</p>
                {Array.from({ length: zipParts }, (_, i) => (
                  <a key={i} href={`/api/albums/${album.id}/download?part=${i + 1}`} className="block rounded-lg px-3 py-2 text-sm hover:bg-stone-100">
                    {i + 1}번째 묶음 ({i * perPart + 1}~{Math.min((i + 1) * perPart, album.photoCount)}번째 사진)
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      {canAdmin && (
        <>
          <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
            수정
          </button>
          <button type="button" className="btn-ghost text-red-600" onClick={() => setDeleting(true)}>
            삭제
          </button>
          <AlbumFormDialog
            open={editing}
            title="앨범 수정"
            initial={album}
            onClose={() => setEditing(false)}
            onSubmit={async (data) => {
              await apiFetch(`/api/albums/${album.id}`, { method: "PUT", json: data });
              toast("앨범을 수정했어요", "success");
              router.refresh();
            }}
          />
          <ConfirmDialog
            open={deleting}
            title="이 앨범을 삭제하시겠습니까?"
            description={
              <div className="space-y-3">
                <p>&lsquo;{album.name}&rsquo; 앨범을 삭제합니다.</p>
                <label className="flex items-start gap-2 rounded-lg bg-stone-50 p-3">
                  <input type="checkbox" className="mt-0.5" checked={deletePhotos} onChange={(e) => setDeletePhotos(e.target.checked)} />
                  <span>
                    앨범 안의 사진 {album.photoCount}장도 함께 휴지통으로 보내기
                    <br />
                    <span className="text-xs text-stone-500">선택하지 않으면 사진은 &lsquo;미분류&rsquo;로 남아요.</span>
                  </span>
                </label>
              </div>
            }
            confirmLabel="삭제"
            danger
            busy={busy}
            onCancel={() => setDeleting(false)}
            onConfirm={async () => {
              setBusy(true);
              try {
                await apiFetch(`/api/albums/${album.id}${deletePhotos ? "?deletePhotos=1" : ""}`, { method: "DELETE" });
                toast("앨범을 삭제했어요", "success");
                router.push("/albums");
                router.refresh();
              } catch (err) {
                toast(errorMessage(err), "error");
                setBusy(false);
              }
            }}
          />
        </>
      )}
    </>
  );
}
