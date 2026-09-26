"use client";

import { hardNavigate } from "@/lib/client-api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACCEPT_ATTR, formatBytes, isAllowedDeclaredMime, isAllowedExtension } from "@/lib/upload-rules";
import { IconCamera, IconCheck, IconClose, IconPhotos, IconRetry, IconUpload } from "./icons";

/**
 * 사진 업로드 (안정성 최우선)
 *
 *  - PC: 파일 선택(여러 장), Drag & Drop / 스마트폰: 앨범에서 선택, 카메라 촬영
 *  - 한 장씩 개별 요청으로 올리고, 동시에 최대 3장까지 병렬 처리
 *  - 파일별 진행률/성공/실패 표시, 실패한 사진만 골라 다시 올리기
 *  - 네트워크 오류/서버 오류(5xx)/429는 자동으로 최대 2번 재시도(지수 백오프)
 *  - 업로드 도중 페이지를 벗어나려 하면 경고
 *  - 서버는 같은 사진(해시 동일)을 중복 저장하지 않으므로 재시도해도 안전하다
 */
type Status = "queued" | "uploading" | "done" | "duplicate" | "error";

interface Item {
  id: string;
  file: File;
  status: Status;
  loaded: number;
  error?: string;
  /** 서버 검증 실패처럼 재시도해도 소용없는 오류 */
  fatal?: boolean;
  preview?: string;
}

const CONCURRENCY = 3;
const AUTO_RETRIES = 2;

function uploadOne(
  file: File,
  fields: Record<string, string>,
  onProgress: (loaded: number) => void,
): Promise<{ ok: true; duplicate: boolean } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v) form.set(k, v);
    form.set("file", file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/photos/upload");
    xhr.timeout = 5 * 60_000;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.min(file.size, (e.loaded / e.total) * file.size));
    xhr.onload = () => {
      let body: { error?: string; duplicate?: boolean } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, duplicate: !!body.duplicate });
      else
        resolve({
          ok: false,
          status: xhr.status,
          error: body.error ?? (xhr.status === 413 ? "파일이 너무 큽니다." : "업로드에 실패했습니다."),
        });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, error: "네트워크 오류로 업로드하지 못했습니다." });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, error: "업로드 시간이 초과되었습니다." });
    xhr.send(form);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Uploader({
  familyId,
  albums,
  defaultAlbumId,
  maxUploadMb,
}: {
  familyId: string;
  albums: { id: string; name: string }[];
  defaultAlbumId?: string;
  maxUploadMb: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [albumId, setAlbumId] = useState(defaultAlbumId ?? "");
  const [dragging, setDragging] = useState(false);
  const running = useRef(0);
  const itemsRef = useRef(items);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const albumRef = useRef(albumId);
  useEffect(() => {
    itemsRef.current = items;
    albumRef.current = albumId;
  });

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const pump = useCallback(() => {
    while (running.current < CONCURRENCY) {
      const next = itemsRef.current.find((it) => it.status === "queued");
      if (!next) return;
      running.current++;
      // 같은 항목이 중복 실행되지 않도록 즉시 상태를 바꾼다
      itemsRef.current = itemsRef.current.map((it) => (it.id === next.id ? { ...it, status: "uploading" } : it));
      update(next.id, { status: "uploading", loaded: 0, error: undefined });
      (async () => {
        let attempt = 0;
        for (;;) {
          const res = await uploadOne(next.file, { familyId, albumId: albumRef.current }, (loaded) => update(next.id, { loaded }));
          if (res.ok) {
            update(next.id, { status: res.duplicate ? "duplicate" : "done", loaded: next.file.size });
            break;
          }
          const transient = res.status === 0 || res.status >= 500 || res.status === 429;
          if (transient && attempt < AUTO_RETRIES) {
            attempt++;
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          if (res.status === 401) hardNavigate("/login?next=/upload");
          update(next.id, { status: "error", error: res.error, fatal: !transient && res.status !== 409, loaded: 0 });
          break;
        }
        running.current--;
        pump();
      })();
    }
  }, [familyId, update]);

  useEffect(() => {
    if (items.some((i) => i.status === "queued")) pump();
  }, [items, pump]);

  const addFiles = (list: FileList | File[]) => {
    const maxBytes = maxUploadMb * 1024 * 1024;
    const next: Item[] = Array.from(list).map((file) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let error: string | undefined;
      if (!isAllowedExtension(file.name) || !isAllowedDeclaredMime(file.type)) error = "지원하지 않는 파일 형식입니다.";
      else if (file.size > maxBytes) error = `${maxUploadMb}MB를 초과합니다.`;
      else if (file.size === 0) error = "빈 파일입니다.";
      const canPreview = !error && /^image\/(jpeg|png|gif|webp|avif)$/.test(file.type);
      return {
        id,
        file,
        status: error ? "error" : "queued",
        loaded: 0,
        error,
        fatal: !!error,
        preview: canPreview ? URL.createObjectURL(file) : undefined,
      };
    });
    setItems((prev) => [...prev, ...next]);
  };

  // 미리보기 URL 메모리 해제
  useEffect(() => () => itemsRef.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  const stats = useMemo(() => {
    const total = items.length;
    const done = items.filter((i) => i.status === "done" || i.status === "duplicate").length;
    const failed = items.filter((i) => i.status === "error").length;
    const retryable = items.filter((i) => i.status === "error" && !i.fatal).length;
    const active = items.filter((i) => i.status === "queued" || i.status === "uploading").length;
    const bytesTotal = items.filter((i) => !i.fatal).reduce((s, i) => s + i.file.size, 0) || 1;
    const bytesDone = items.filter((i) => !i.fatal).reduce((s, i) => s + i.loaded, 0);
    return { total, done, failed, retryable, active, percent: Math.round((bytesDone / bytesTotal) * 100) };
  }, [items]);

  // 업로드 중 페이지 이탈 경고
  useEffect(() => {
    if (stats.active === 0) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [stats.active]);

  const retry = (id?: string) =>
    setItems((prev) =>
      prev.map((i) => (i.status === "error" && !i.fatal && (!id || i.id === id) ? { ...i, status: "queued", error: undefined, loaded: 0 } : i)),
    );
  const remove = (id: string) =>
    setItems((prev) => {
      const t = prev.find((i) => i.id === id);
      if (t?.preview) URL.revokeObjectURL(t.preview);
      return prev.filter((i) => i.id !== id);
    });
  const clearFinished = () =>
    setItems((prev) => prev.filter((i) => i.status === "queued" || i.status === "uploading" || (i.status === "error" && !i.fatal)));

  const finished = stats.total > 0 && stats.active === 0;

  return (
    <div className="space-y-4">
      {albums.length > 0 && (
        <div className="card p-4">
          <label htmlFor="album" className="label">
            어느 앨범에 올릴까요?
          </label>
          <select id="album" className="input" value={albumId} onChange={(e) => setAlbumId(e.target.value)} disabled={stats.active > 0}>
            <option value="">미분류 (앨범 없이 올리기)</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        className={`card flex flex-col items-center gap-4 border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? "border-brand-400 bg-brand-50" : "border-stone-300"
        }`}
      >
        <div className="rounded-full bg-brand-100 p-4 text-brand-600">
          <IconUpload className="h-8 w-8" />
        </div>
        <div>
          <p className="text-lg font-bold text-stone-800">사진을 올려주세요</p>
          <p className="mt-1 hidden text-sm text-stone-500 md:block">여기로 사진을 끌어다 놓거나, 아래 버튼으로 선택하세요.</p>
          <p className="mt-1 text-xs text-stone-400">
            JPG · PNG · WEBP · GIF · AVIF · HEIC / 한 장당 최대 {maxUploadMb}MB / 여러 장 동시 선택 가능
          </p>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row">
          <button type="button" className="btn-primary flex-1 py-3" onClick={() => fileInput.current?.click()}>
            <IconPhotos /> 사진 선택
          </button>
          <button type="button" className="btn-secondary flex-1 py-3 md:hidden" onClick={() => cameraInput.current?.click()}>
            <IconCamera /> 카메라로 촬영
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {stats.total > 0 && (
        <div className="card sticky top-16 z-10 p-4 md:top-4" aria-live="polite">
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-semibold text-stone-800">
              {finished ? (stats.failed ? `업로드 완료 (실패 ${stats.failed}장)` : "업로드 완료! 🎉") : `사진 ${stats.total}장 업로드 중`}
            </p>
            <p className="text-sm tabular-nums text-stone-500">
              {stats.done} / {stats.total} 업로드 완료
            </p>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={stats.percent} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-full transition-all ${stats.failed && finished ? "bg-amber-500" : "bg-brand-500"}`}
              style={{ width: `${finished ? 100 : stats.percent}%` }}
            />
          </div>
          <p className="mt-1 text-right text-xs tabular-nums text-stone-500">{finished ? 100 : stats.percent}%</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {stats.retryable > 0 && stats.active === 0 && (
              <button type="button" className="btn-primary" onClick={() => retry()}>
                <IconRetry /> 실패한 사진 다시 올리기 ({stats.retryable})
              </button>
            )}
            {finished && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    router.push(albumId ? `/albums/${albumId}` : "/photos");
                    router.refresh();
                  }}
                >
                  사진 보러 가기
                </button>
                <button type="button" className="btn-ghost" onClick={clearFinished}>
                  목록 정리
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <ul className="card divide-y divide-stone-100">
          {items.map((it) => {
            const pct = it.status === "done" || it.status === "duplicate" ? 100 : Math.round((it.loaded / (it.file.size || 1)) * 100);
            return (
              <li key={it.id} className="flex items-center gap-3 p-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-stone-100">
                  {it.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.preview} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-stone-400">
                      <IconPhotos />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-stone-800">{it.file.name}</p>
                  <p className="text-xs text-stone-500">
                    {formatBytes(it.file.size)} ·{" "}
                    {it.status === "queued" && "대기 중"}
                    {it.status === "uploading" && (pct >= 100 ? "처리 중…" : `${pct}%`)}
                    {it.status === "done" && <span className="text-emerald-600">성공</span>}
                    {it.status === "duplicate" && <span className="text-emerald-600">이미 올라간 사진</span>}
                    {it.status === "error" && <span className="text-red-600">실패 – {it.error}</span>}
                  </p>
                  {(it.status === "uploading" || it.status === "queued") && (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-100">
                      <div className="h-full rounded-full bg-brand-400 transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  {(it.status === "done" || it.status === "duplicate") && (
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-50 text-emerald-600" aria-label="성공">
                      <IconCheck />
                    </span>
                  )}
                  {it.status === "error" && (
                    <div className="flex">
                      {!it.fatal && (
                        <button type="button" className="rounded-full p-2 text-brand-600 hover:bg-brand-50" onClick={() => retry(it.id)} aria-label="다시 올리기">
                          <IconRetry />
                        </button>
                      )}
                      <button type="button" className="rounded-full p-2 text-stone-400 hover:bg-stone-100" onClick={() => remove(it.id)} aria-label="목록에서 제거">
                        <IconClose />
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {finished && stats.failed === 0 && (
        <p className="text-center text-sm text-stone-500">
          더 올릴 사진이 있나요? 위 버튼으로 계속 추가할 수 있어요. <Link href="/" className="text-brand-600 underline">홈으로</Link>
        </p>
      )}
    </div>
  );
}
