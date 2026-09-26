import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveCurrentFamily } from "./access";
import { FAMILY_COOKIE, getCurrentUser } from "./session";

/**
 * Server Component에서 사용하는 공통 컨텍스트 (요청당 1회만 계산되도록 cache).
 * 로그인하지 않았다면 로그인 페이지로 이동시킨다.
 */
export const getPageContext = cache(async () => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const store = await cookies();
  const { current, memberships } = await resolveCurrentFamily(user.id, store.get(FAMILY_COOKIE)?.value);
  return {
    user,
    family: current ? { id: current.family.id, name: current.family.name, description: current.family.description } : null,
    role: current?.role ?? null,
    isFamilyAdmin: current?.role === "ADMIN",
    families: memberships.map((m) => ({ id: m.family.id, name: m.family.name })),
  };
});

/** 가족이 반드시 있어야 하는 페이지용 */
export async function requireFamilyContext() {
  const ctx = await getPageContext();
  if (!ctx.family) redirect("/family");
  return ctx as typeof ctx & { family: NonNullable<typeof ctx.family> };
}
