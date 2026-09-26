"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toQueryString } from "@/lib/query-string";
import { IconSearch } from "./icons";

interface FilterState {
  q: string;
  albumId: string;
  uploaderId: string;
  dateField: "taken" | "uploaded";
  preset: string;
  from: string;
  to: string;
}

const PRESETS = [
  { value: "", label: "전체 기간" },
  { value: "today", label: "오늘" },
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
  { value: "year", label: "올해" },
  { value: "custom", label: "직접 지정" },
];

/** 사진 검색 조건. URL 쿼리스트링과 동기화되어 뒤로가기/공유가 자연스럽다. */
export function PhotoFilters({
  albums,
  members,
  initial,
}: {
  albums: { id: string; name: string }[];
  members: { id: string; name: string }[];
  initial: FilterState;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [s, setS] = useState<FilterState>(initial);
  const [open, setOpen] = useState(!!(initial.albumId || initial.uploaderId || initial.preset));
  const [pending, start] = useTransition();

  const apply = (next: FilterState) => {
    setS(next);
    const qs = toQueryString({
      ...next,
      dateField: next.dateField === "uploaded" ? undefined : next.dateField,
      from: next.preset === "custom" ? next.from : undefined,
      to: next.preset === "custom" ? next.to : undefined,
    });
    start(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  return (
    <form
      role="search"
      className="card mb-4 space-y-3 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        apply(s);
      }}
    >
      <div className="flex gap-2">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-stone-400" />
          <input
            type="search"
            className="input pl-10"
            placeholder="설명, 파일명, 앨범, 올린 사람 검색"
            value={s.q}
            maxLength={100}
            onChange={(e) => setS({ ...s, q: e.target.value })}
            aria-label="검색어"
          />
        </div>
        <button type="submit" className="btn-primary" disabled={pending}>
          검색
        </button>
        <button type="button" className="btn-secondary" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          필터
        </button>
      </div>
      {open && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <select className="input" value={s.albumId} onChange={(e) => apply({ ...s, albumId: e.target.value })} aria-label="앨범">
            <option value="">모든 앨범</option>
            <option value="none">미분류</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select className="input" value={s.uploaderId} onChange={(e) => apply({ ...s, uploaderId: e.target.value })} aria-label="올린 사람">
            <option value="">모든 가족</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={s.dateField}
            onChange={(e) => apply({ ...s, dateField: e.target.value as FilterState["dateField"] })}
            aria-label="날짜 기준"
          >
            <option value="uploaded">올린 날짜 기준</option>
            <option value="taken">촬영 날짜 기준</option>
          </select>
          <select className="input" value={s.preset} onChange={(e) => apply({ ...s, preset: e.target.value })} aria-label="기간">
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {s.preset === "custom" && (
            <div className="col-span-2 flex items-center gap-2 md:col-span-4">
              <input type="date" className="input" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} aria-label="시작일" />
              <span className="text-stone-400">~</span>
              <input type="date" className="input" value={s.to} onChange={(e) => setS({ ...s, to: e.target.value })} aria-label="종료일" />
              <button type="button" className="btn-secondary shrink-0" onClick={() => apply(s)}>
                적용
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn-ghost col-span-2 md:col-span-4"
            onClick={() => apply({ q: "", albumId: "", uploaderId: "", dateField: "uploaded", preset: "", from: "", to: "" })}
          >
            조건 초기화
          </button>
        </div>
      )}
    </form>
  );
}
