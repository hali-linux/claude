"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoDTO, PhotoPage } from "@/types";
import { apiFetch, errorMessage } from "@/lib/client-api";
import { IconStar } from "./icons";
import { Lightbox, type LightboxContext } from "./lightbox";
import { useToast } from "./toast";

/**
 * 사진 갤러리 (반응형 Grid + 무한 스크롤 + Lightbox)
 *
 * 성능
 *  - 썸네일(최대 640px WebP)만 그리드에 표시하고, 원본에 가까운 대형 이미지는 Lightbox에서만 로드
 *  - loading="lazy" + decoding="async"로 화면에 보이는 사진만 불러온다
 *  - 커서 기반 페이지네이션으로 사진이 수만 장이어도 일정한 속도
 */
export function Gallery({
  initial,
  query,
  emptyMessage,
  context,
  infinite = true,
  onCountChange,
}: {
  initial: PhotoPage;
  /** /api/photos 에 보낼 쿼리스트링(커서 제외) */
  query: string;
  emptyMessage?: React.ReactNode;
  context: LightboxContext;
  infinite?: boolean;
  onCountChange?: (delta: number) => void;
}) {
  const [items, setItems] = useState<PhotoDTO[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const loadMore = useCallback(async () => {
    if (!cursor || loading || !infinite) return;
    setLoading(true);
    try {
      const page = await apiFetch<PhotoPage>(`/api/photos?${query}${query ? "&" : ""}cursor=${cursor}`);
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, infinite, query, toast]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !infinite) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore(), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, infinite]);

  if (items.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center px-6 py-16 text-center text-stone-500">
        {emptyMessage ?? "아직 사진이 없어요."}
      </div>
    );
  }

  return (
    <>
      <ul className="grid grid-cols-3 gap-0.5 overflow-hidden rounded-xl sm:grid-cols-4 sm:gap-1 md:grid-cols-5 lg:grid-cols-6">
        {items.map((p, i) => (
          <li key={p.id} className="relative aspect-square bg-stone-200">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="group block h-full w-full overflow-hidden focus-visible:outline-3 focus-visible:outline-brand-500"
              aria-label={`${p.description || p.originalName} 크게 보기`}
            >
              {/* 인증이 필요한 이미지이므로 next/image 최적화(서버가 대신 fetch) 대신 img 사용 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.thumbUrl}
                alt={p.description || p.originalName}
                loading={i < 12 ? "eager" : "lazy"}
                decoding="async"
                className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              />
            </button>
            {p.isFavorite && (
              <span className="pointer-events-none absolute right-1 top-1 text-amber-400 drop-shadow">
                <IconStar filled className="h-4 w-4" />
              </span>
            )}
          </li>
        ))}
      </ul>
      {infinite && cursor && (
        <div ref={sentinel} className="flex justify-center py-8">
          <button type="button" className="btn-secondary" onClick={loadMore} disabled={loading}>
            {loading ? "불러오는 중…" : "더 보기"}
          </button>
        </div>
      )}

      {open !== null && items[open] && (
        <Lightbox
          photos={items}
          index={open}
          context={context}
          onIndexChange={(i) => {
            setOpen(i);
            if (i >= items.length - 3) loadMore();
          }}
          onClose={() => setOpen(null)}
          onChange={(photo) => setItems((prev) => prev.map((p) => (p.id === photo.id ? photo : p)))}
          onDelete={(id) => {
            const idx = items.findIndex((p) => p.id === id);
            const next = items.filter((p) => p.id !== id);
            setItems(next);
            onCountChange?.(-1);
            if (next.length === 0) setOpen(null);
            else setOpen(Math.min(idx, next.length - 1));
          }}
        />
      )}
    </>
  );
}
