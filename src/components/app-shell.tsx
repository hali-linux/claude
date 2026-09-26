"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FamilySwitcher, type FamilyOption } from "./family-switcher";
import { IconUpload } from "./icons";

const NAV = [
  { href: "/", label: "홈", emoji: "🏠" },
  { href: "/photos", label: "사진", emoji: "📷" },
  { href: "/albums", label: "앨범", emoji: "📁" },
  { href: "/favorites", label: "즐겨찾기", emoji: "⭐" },
  { href: "/family", label: "가족", emoji: "👨‍👩‍👧‍👦" },
  { href: "/settings", label: "설정", emoji: "⚙️" },
];
// 모바일 하단 탭은 5개까지만 (설정은 상단 헤더 아이콘으로)
const MOBILE_NAV = NAV.slice(0, 5);

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  children,
  userName,
  families,
  currentFamilyId,
  isFamilyAdmin,
}: {
  children: React.ReactNode;
  userName: string;
  families: FamilyOption[];
  currentFamilyId: string;
  isFamilyAdmin: boolean;
}) {
  const pathname = usePathname();
  const showFab = !pathname.startsWith("/upload") && !pathname.startsWith("/admin") && !pathname.startsWith("/settings");

  return (
    <div className="min-h-dvh md:pl-60">
      {/* 데스크톱 사이드바 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-stone-200 bg-white/80 px-4 py-6 backdrop-blur md:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-bold text-stone-900">
          <span className="text-2xl">📸</span> 우리 가족 사진
        </Link>
        <FamilySwitcher families={families} currentFamilyId={currentFamilyId} />
        <nav className="mt-6 flex flex-col gap-1" aria-label="주 메뉴">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition ${
                isActive(pathname, n.href) ? "bg-brand-50 text-brand-700" : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              <span className="w-6 text-center text-lg">{n.emoji}</span>
              {n.label}
            </Link>
          ))}
          {isFamilyAdmin && (
            <Link
              href="/admin"
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition ${
                isActive(pathname, "/admin") ? "bg-brand-50 text-brand-700" : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              <span className="w-6 text-center text-lg">🛠️</span>관리자
            </Link>
          )}
        </nav>
        <Link href="/upload" className="btn-primary mt-6">
          <IconUpload /> 사진 올리기
        </Link>
        <p className="mt-auto px-2 text-xs text-stone-400">{userName}님, 반가워요</p>
      </aside>

      {/* 모바일 상단 헤더 */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-stone-200/70 bg-brand-50/90 px-4 py-3 backdrop-blur md:hidden">
        <FamilySwitcher families={families} currentFamilyId={currentFamilyId} compact />
        <div className="flex items-center gap-1">
          {isFamilyAdmin && (
            <Link href="/admin" aria-label="관리자" className="rounded-full p-2 text-xl hover:bg-white">
              🛠️
            </Link>
          )}
          <Link href="/settings" aria-label="설정" className="rounded-full p-2 text-xl hover:bg-white">
            ⚙️
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-3 pb-28 pt-4 sm:px-6 md:pb-12 md:pt-8">{children}</main>

      {/* 모바일 사진 업로드 버튼 */}
      {showFab && (
        <Link
          href="/upload"
          aria-label="사진 올리기"
          className="fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg shadow-brand-500/30 active:scale-95 md:hidden"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        >
          <IconUpload className="h-6 w-6" />
        </Link>
      )}

      {/* 모바일 하단 내비게이션 */}
      <nav
        aria-label="하단 메뉴"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white/95 backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-5">
          {MOBILE_NAV.map((n) => {
            const active = isActive(pathname, n.href);
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
                    active ? "text-brand-600" : "text-stone-500"
                  }`}
                >
                  <span className={`text-xl leading-6 ${active ? "" : "opacity-70 grayscale-[40%]"}`}>{n.emoji}</span>
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
