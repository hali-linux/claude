import "server-only";
import type { NextRequest } from "next/server";
import { resolveCurrentFamily } from "./access";
import { notFound } from "./errors";
import { FAMILY_COOKIE, type AuthUser } from "./session";

/**
 * 요청에서 대상 가족 ID를 결정한다.
 * 명시적 familyId가 있으면 그것을, 없으면 쿠키에 저장된 "현재 가족"을 사용한다.
 * (어느 경우든 서비스 계층에서 멤버십을 다시 검사한다.)
 */
export async function familyIdFor(req: NextRequest, user: AuthUser, explicit?: string | null): Promise<string> {
  if (explicit) return explicit;
  const { current } = await resolveCurrentFamily(user.id, req.cookies.get(FAMILY_COOKIE)?.value);
  if (!current) throw notFound("참여 중인 가족이 없습니다.");
  return current.familyId;
}
