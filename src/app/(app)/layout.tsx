import { AppShell } from "@/components/app-shell";
import { NoFamily } from "@/components/family/no-family";
import { getPageContext } from "@/lib/page-context";

/** 로그인 사용자 전용 영역. 모든 페이지에서 서버 측 세션 검사를 다시 수행한다. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getPageContext();
  if (!ctx.family) return <NoFamily userName={ctx.user.name} />;
  return (
    <AppShell userName={ctx.user.name} families={ctx.families} currentFamilyId={ctx.family.id} isFamilyAdmin={ctx.isFamilyAdmin}>
      {children}
    </AppShell>
  );
}
