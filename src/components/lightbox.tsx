"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PhotoDTO } from "@/types";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { ConfirmDialog } from "./confirm-dialog";
import { IconClose, IconDownload, IconInfo, IconLeft, IconRight, IconStar, IconTrash, IconZoomIn, IconZoomOut } from "./icons";
import { useToast } from "./toast";

export interface LightboxContext {
  albums: { id: string; name: string }[];
  isFamilyAdmin: boolean;
  /** 앨범 화면에서 열었을 때: 대표사진 지정 기능 제공 */
  album?: { id: string; coverPhotoId: string | null };
}

const ZOOM = 2.5;

/**
 * 사진 크게 보기
 *  - ← → 키, 화면 좌우 버튼, 모바일 좌우 Swipe로 이동 / ESC로 닫기 / 아래로 Swipe로 닫기
 *  - 더블클릭(더블탭) 또는 돋보기 버튼으로 확대, 확대 상태에서는 드래그로 이동
 *  - 즐겨찾기, 다운로드, 삭제(확인창), 사진 정보/설명 수정
 *  - 휴대폰의 "뒤로가기" 버튼으로 닫을 수 있도록 history 항목을 추가한다
 */
export function Lightbox({
  photos,
  index,
  context,
  onIndexChange,
  onClose,
  onChange,
  onDelete,
}: {
  photos: PhotoDTO[];
  index: number;
  context: LightboxContext;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  onChange: (p: PhotoDTO) => void;
  onDelete: (id: string) => void;
}) {
  const photo = photos[index]!;
  const toast = useToast();
  const router = useRouter();
  const [zoomed, setZoomed] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showInfo, setShowInfo] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number; t: number } | null>(null);
  const [dragDx, setDragDx] = useState(0);
  const [dragging, setDragging] = useState(false);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  const resetView = () => {
    setZoomed(false);
    setPan({ x: 0, y: 0 });
    setDragDx(0);
  };
  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0 || next >= photos.length) return;
      resetView();
      setLoaded(false);
      onIndexChange(next);
    },
    [index, photos.length, onIndexChange],
  );

  // 뒤로가기 버튼으로 닫기
  const closedByPop = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    window.history.pushState({ ...window.history.state, lightbox: true }, "");
    const onPop = () => {
      closedByPop.current = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("popstate", onPop);
      document.body.style.overflow = prevOverflow;
    };
  }, []);
  const close = useCallback(() => {
    if (!closedByPop.current && window.history.state?.lightbox) window.history.back();
    else onClose();
  }, [onClose]);

  // 키보드
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmDelete) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, close, confirmDelete]);

  // 이전/다음 사진 미리 불러오기
  useEffect(() => {
    for (const i of [index - 1, index + 1]) {
      const p = photos[i];
      if (p) new Image().src = p.largeUrl;
    }
  }, [index, photos]);

  // 터치/마우스 제스처
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, t: Date.now() };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (zoomed) setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
    else setDragDx(e.clientX - d.x);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || zoomed) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setDragDx(0);
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 120 && Math.abs(dy) > Math.abs(dx) * 1.5) close();
  };
  const toggleZoom = () => {
    setZoomed((z) => !z);
    setPan({ x: 0, y: 0 });
  };

  const toggleFavorite = async () => {
    const on = !photo.isFavorite;
    onChange({ ...photo, isFavorite: on });
    try {
      await apiFetch(`/api/photos/${photo.id}/favorite`, { method: on ? "POST" : "DELETE" });
      toast(on ? "즐겨찾기에 추가했어요 ⭐" : "즐겨찾기에서 뺐어요");
    } catch (err) {
      onChange({ ...photo, isFavorite: !on });
      toast(errorMessage(err), "error");
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await apiFetch(`/api/photos/${photo.id}`, { method: "DELETE" });
      setConfirmDelete(false);
      toast("사진을 삭제했어요. (관리자가 휴지통에서 복구할 수 있어요)", "success");
      onDelete(photo.id);
      router.refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex bg-black text-white" role="dialog" aria-modal="true" aria-label="사진 보기">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* 상단 툴바 */}
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-2 pb-6 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <button type="button" onClick={close} className="rounded-full p-2.5 hover:bg-white/10" aria-label="닫기 (ESC)">
            <IconClose className="h-6 w-6" />
          </button>
          <span className="text-sm tabular-nums text-white/80">
            {index + 1} / {photos.length}
          </span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={toggleFavorite}
              className={`rounded-full p-2.5 hover:bg-white/10 ${photo.isFavorite ? "text-amber-400" : ""}`}
              aria-label={photo.isFavorite ? "즐겨찾기 해제" : "즐겨찾기"}
              aria-pressed={photo.isFavorite}
            >
              <IconStar filled={photo.isFavorite} />
            </button>
            <button type="button" onClick={toggleZoom} className="rounded-full p-2.5 hover:bg-white/10" aria-label={zoomed ? "축소" : "확대"}>
              {zoomed ? <IconZoomOut /> : <IconZoomIn />}
            </button>
            <a href={photo.downloadUrl} className="rounded-full p-2.5 hover:bg-white/10" aria-label="원본 다운로드" download>
              <IconDownload />
            </a>
            <button
              type="button"
              onClick={() => setShowInfo((s) => !s)}
              className={`rounded-full p-2.5 hover:bg-white/10 ${showInfo ? "bg-white/15" : ""}`}
              aria-label="사진 정보"
              aria-pressed={showInfo}
            >
              <IconInfo />
            </button>
            {photo.canModify && (
              <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-full p-2.5 hover:bg-white/10" aria-label="삭제">
                <IconTrash />
              </button>
            )}
          </div>
        </div>

        {/* 사진 */}
        <div
          className="relative flex flex-1 touch-none select-none items-center justify-center overflow-hidden"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
            setDragDx(0);
          }}
          onDoubleClick={toggleZoom}
          style={{ cursor: zoomed ? "grab" : "default" }}
        >
          {!loaded && (
            // 대형 이미지가 로드되기 전 썸네일을 먼저 보여준다
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo.thumbUrl} alt="" aria-hidden className="absolute max-h-full max-w-full scale-100 object-contain blur-sm" />
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={photo.id}
            src={photo.largeUrl}
            alt={photo.description || photo.originalName}
            draggable={false}
            onLoad={() => setLoaded(true)}
            className={`relative max-h-full max-w-full object-contain transition-opacity duration-200 ${loaded ? "opacity-100" : "opacity-0"}`}
            style={{
              transform: zoomed
                ? `translate(${pan.x}px, ${pan.y}px) scale(${ZOOM})`
                : `translateX(${dragDx}px)`,
              transition: dragging ? "none" : "transform 0.2s ease-out, opacity 0.2s",
            }}
          />
        </div>

        {hasPrev && (
          <button
            type="button"
            onClick={() => go(-1)}
            className="absolute left-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-3 hover:bg-black/60 md:block"
            aria-label="이전 사진 (←)"
          >
            <IconLeft className="h-6 w-6" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={() => go(1)}
            className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-full bg-black/40 p-3 hover:bg-black/60 md:block"
            aria-label="다음 사진 (→)"
          >
            <IconRight className="h-6 w-6" />
          </button>
        )}

        {photo.description && !showInfo && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-10 text-center text-sm text-white/90">
            {photo.description}
          </div>
        )}
      </div>

      {showInfo && (
        <PhotoInfoPanel photo={photo} context={context} onChange={onChange} onClose={() => setShowInfo(false)} />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="이 사진을 삭제하시겠습니까?"
        description="삭제한 사진은 휴지통으로 이동하며, 가족 관리자가 복구할 수 있습니다."
        confirmLabel="삭제"
        danger
        busy={busy}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function PhotoInfoPanel({
  photo,
  context,
  onChange,
  onClose,
}: {
  photo: PhotoDTO;
  context: LightboxContext;
  onChange: (p: PhotoDTO) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [description, setDescription] = useState(photo.description ?? "");
  const [saving, setSaving] = useState(false);
  const [lastId, setLastId] = useState(photo.id);
  if (lastId !== photo.id) {
    setLastId(photo.id);
    setDescription(photo.description ?? "");
  }

  const patch = async (data: Record<string, unknown>, okMessage: string) => {
    setSaving(true);
    try {
      const res = await apiFetch<{ photo: PhotoDTO }>(`/api/photos/${photo.id}`, { method: "PATCH", json: data });
      onChange({ ...res.photo, isFavorite: photo.isFavorite });
      toast(okMessage, "success");
      router.refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const setCover = async () => {
    if (!context.album) return;
    try {
      await apiFetch(`/api/albums/${context.album.id}`, { method: "PUT", json: { coverPhotoId: photo.id } });
      toast("앨범 대표사진으로 지정했어요", "success");
      router.refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  const rows: [string, React.ReactNode][] = [
    ["파일명", <span key="n" className="break-all">{photo.originalName}</span>],
    ["올린 사람", photo.uploader?.name ?? "알 수 없음"],
    ["올린 날짜", formatDateTime(photo.createdAt)],
    ["촬영 날짜", photo.takenAt ? formatDateTime(photo.takenAt) : "정보 없음"],
    ["앨범", photo.album?.name ?? "미분류"],
    ["파일 크기", formatBytes(photo.sizeBytes)],
    ["해상도", `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}`],
  ];

  return (
    <aside className="absolute inset-x-0 bottom-0 z-20 max-h-[70dvh] overflow-y-auto rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-stone-800 shadow-2xl md:static md:max-h-none md:w-96 md:rounded-none">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">사진 정보</h2>
        <button type="button" onClick={onClose} className="rounded-full p-2 hover:bg-stone-100" aria-label="정보 닫기">
          <IconClose />
        </button>
      </div>
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-stone-500">{k}</dt>
            <dd className="text-stone-800">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5">
        <label htmlFor="photo-desc" className="label">
          설명
        </label>
        {photo.canModify ? (
          <>
            <textarea
              id="photo-desc"
              className="input min-h-20"
              maxLength={2000}
              value={description}
              placeholder="이 사진에 대한 이야기를 남겨보세요"
              onChange={(e) => setDescription(e.target.value)}
            />
            <button
              type="button"
              className="btn-primary mt-2 w-full"
              disabled={saving || description === (photo.description ?? "")}
              onClick={() => patch({ description }, "설명을 저장했어요")}
            >
              설명 저장
            </button>
          </>
        ) : (
          <p className="text-sm text-stone-600">{photo.description || "설명이 없어요."}</p>
        )}
      </div>

      {photo.canModify && context.albums.length > 0 && (
        <div className="mt-5">
          <label htmlFor="photo-album" className="label">
            앨범 이동
          </label>
          <select
            id="photo-album"
            className="input"
            value={photo.album?.id ?? ""}
            disabled={saving}
            onChange={(e) => patch({ albumId: e.target.value || null }, "앨범을 옮겼어요")}
          >
            <option value="">미분류</option>
            {context.albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {context.isFamilyAdmin && context.album && photo.album?.id === context.album.id && (
        <button type="button" className="btn-secondary mt-5 w-full" onClick={setCover}>
          🖼️ 앨범 대표사진으로 지정
        </button>
      )}
    </aside>
  );
}
