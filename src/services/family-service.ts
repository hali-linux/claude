import "server-only";
import { prisma } from "@/lib/db";
import { requireFamilyAdmin, requireMembership } from "@/lib/access";
import { badRequest, notFound } from "@/lib/errors";
import type { AuthUser } from "@/lib/session";
import type { FamilyRole } from "@/generated/prisma/enums";

export async function listMyFamilies(user: AuthUser) {
  const rows = await prisma.familyMember.findMany({
    where: { userId: user.id },
    orderBy: { joinedAt: "asc" },
    include: { family: { include: { _count: { select: { members: true } } } } },
  });
  return rows.map((r) => ({
    id: r.family.id,
    name: r.family.name,
    description: r.family.description,
    role: r.role,
    memberCount: r.family._count.members,
  }));
}

export async function createFamily(user: AuthUser, data: { name: string; description?: string | null }) {
  return prisma.family.create({
    data: {
      name: data.name,
      description: data.description || null,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
}

export async function updateFamily(user: AuthUser, familyId: string, data: { name: string; description?: string | null }) {
  await requireFamilyAdmin(user, familyId);
  return prisma.family.update({ where: { id: familyId }, data: { name: data.name, description: data.description || null } });
}

export async function listMembers(user: AuthUser, familyId: string) {
  await requireMembership(user, familyId);
  const members = await prisma.familyMember.findMany({
    where: { familyId },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

async function assertNotLastAdmin(familyId: string, targetUserId: string) {
  const admins = await prisma.familyMember.findMany({ where: { familyId, role: "ADMIN" }, select: { userId: true } });
  if (admins.length === 1 && admins[0]!.userId === targetUserId) {
    throw badRequest("가족에는 최소 한 명의 관리자가 있어야 합니다. 다른 구성원을 먼저 관리자로 지정해주세요.");
  }
}

export async function updateMemberRole(user: AuthUser, familyId: string, targetUserId: string, role: FamilyRole) {
  await requireFamilyAdmin(user, familyId);
  const target = await prisma.familyMember.findUnique({ where: { familyId_userId: { familyId, userId: targetUserId } } });
  if (!target) throw notFound();
  if (role !== "ADMIN") await assertNotLastAdmin(familyId, targetUserId);
  await prisma.familyMember.update({ where: { id: target.id }, data: { role } });
}

/** 관리자가 구성원을 제거하거나, 구성원이 스스로 가족에서 나간다. 업로드한 사진은 가족에 남는다. */
export async function removeMember(user: AuthUser, familyId: string, targetUserId: string) {
  if (targetUserId === user.id) await requireMembership(user, familyId);
  else await requireFamilyAdmin(user, familyId);
  const target = await prisma.familyMember.findUnique({ where: { familyId_userId: { familyId, userId: targetUserId } } });
  if (!target) throw notFound();
  await assertNotLastAdmin(familyId, targetUserId);
  await prisma.familyMember.delete({ where: { id: target.id } });
}
