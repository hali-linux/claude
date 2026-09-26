import "server-only";
import { prisma } from "./db";
import { forbidden, notFound } from "./errors";
import type { AuthUser } from "./session";
import type { FamilyRole } from "@/generated/prisma/enums";

/**
 * 가족 그룹 단위 접근 제어 (IDOR 방지의 핵심).
 *
 * 모든 리소스(사진/앨범/초대/구성원) 접근은 다음 순서를 따른다.
 *   1) 리소스를 id로 조회하여 familyId를 알아낸다.
 *   2) 요청 사용자가 해당 familyId의 구성원인지 확인한다.
 *   3) 구성원이 아니면 403이 아닌 404를 반환하여 리소스의 존재 여부도 노출하지 않는다.
 * 클라이언트가 보낸 familyId를 그대로 믿지 않고, 항상 DB에 저장된 리소스의 familyId로 검사한다.
 */
export interface Membership {
  familyId: string;
  userId: string;
  role: FamilyRole;
}

export async function getMembership(userId: string, familyId: string): Promise<Membership | null> {
  if (!familyId) return null;
  return prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId, userId } },
    select: { familyId: true, userId: true, role: true },
  });
}

export async function requireMembership(user: AuthUser, familyId: string): Promise<Membership> {
  const m = await getMembership(user.id, familyId);
  if (!m) throw notFound();
  return m;
}

export async function requireFamilyAdmin(user: AuthUser, familyId: string): Promise<Membership> {
  const m = await requireMembership(user, familyId);
  if (m.role !== "ADMIN") throw forbidden("가족 관리자만 할 수 있는 작업입니다.");
  return m;
}

export const isFamilyAdmin = (m: Membership | null | undefined) => m?.role === "ADMIN";

/** 사진 삭제/수정 권한: 가족 관리자는 모든 사진, 일반 구성원은 자신이 올린 사진만 */
export function canModifyPhoto(m: Membership, photo: { uploaderId: string | null }) {
  return m.role === "ADMIN" || (photo.uploaderId !== null && photo.uploaderId === m.userId);
}

/**
 * 현재 선택된 가족 결정.
 * 쿠키에 저장된 familyId라도 반드시 멤버십을 다시 확인한다(쿠키 조작 대비).
 */
export async function resolveCurrentFamily(userId: string, preferredFamilyId?: string | null) {
  const memberships = await prisma.familyMember.findMany({
    where: { userId },
    include: { family: { select: { id: true, name: true, description: true } } },
    orderBy: { joinedAt: "asc" },
  });
  if (memberships.length === 0) return { current: null, memberships };
  const current = memberships.find((m) => m.familyId === preferredFamilyId) ?? memberships[0]!;
  return { current, memberships };
}
