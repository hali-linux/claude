import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { hashToken, randomToken } from "@/lib/crypto";
import { requireFamilyAdmin } from "@/lib/access";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import type { AuthUser } from "@/lib/session";
import type { FamilyRole } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { sendMail } from "./mail";

/**
 * 초대 링크
 *  - 256bit 무작위 토큰 → 추측 불가능
 *  - DB에는 HMAC 해시만 저장 → DB가 유출되어도 링크를 재구성할 수 없음
 *  - 만료 시간(기본 72시간) + 1회용(원자적 updateMany로 동시 사용 경쟁 조건 방지)
 *  - 초대받은 이메일로 로그인/가입한 사용자만 수락 가능 → 링크가 유출되어도 제3자가 가입할 수 없음
 */
export async function createInvitation(
  user: AuthUser,
  input: { familyId: string; email: string; role: FamilyRole },
) {
  await requireFamilyAdmin(user, input.familyId);

  const existingMember = await prisma.familyMember.findFirst({
    where: { familyId: input.familyId, user: { email: input.email } },
  });
  if (existingMember) throw conflict("이미 가족 구성원인 이메일입니다.");

  const now = new Date();
  // 같은 이메일로 보낸 이전 초대는 폐기(가장 최근 링크만 유효)
  await prisma.invitation.updateMany({
    where: { familyId: input.familyId, email: input.email, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });

  const token = randomToken(32);
  const invitation = await prisma.invitation.create({
    data: {
      familyId: input.familyId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedById: user.id,
      expiresAt: new Date(now.getTime() + env().INVITATION_TTL_HOURS * 3600_000),
    },
    include: { family: { select: { name: true } } },
  });

  const url = `${env().APP_URL.replace(/\/$/, "")}/invite/${token}`;
  const emailSent = await sendMail(
    input.email,
    `[우리 가족 사진] ${invitation.family.name}에 초대되었습니다`,
    `${user.name}님이 "${invitation.family.name}" 가족 사진첩에 초대했습니다.\n\n아래 링크에서 가입 또는 로그인 후 참여해주세요.\n${url}\n\n이 링크는 ${env().INVITATION_TTL_HOURS}시간 동안 한 번만 사용할 수 있습니다.`,
  );

  return { invitation, url, emailSent };
}

export async function findValidInvitation(token: string) {
  if (!token || token.length > 128) return null;
  const inv = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { family: { select: { id: true, name: true } }, invitedBy: { select: { name: true } } },
  });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt <= new Date()) return null;
  return inv;
}

/** 트랜잭션 내에서 초대를 원자적으로 사용 처리하고 가족 구성원으로 추가 */
export async function consumeInvitationInTx(
  tx: Prisma.TransactionClient,
  invitationId: string,
  userId: string,
  familyId: string,
  role: FamilyRole,
) {
  const now = new Date();
  const { count } = await tx.invitation.updateMany({
    where: { id: invitationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now, acceptedById: userId },
  });
  if (count !== 1) throw badRequest("초대 링크가 만료되었거나 이미 사용되었습니다.", "INVITE_INVALID");
  await tx.familyMember.create({ data: { familyId, userId, role } });
  await tx.activity.create({ data: { familyId, actorId: userId, type: "MEMBER_JOIN" } });
}

export async function acceptInvitation(user: AuthUser, token: string) {
  const inv = await findValidInvitation(token);
  if (!inv) throw badRequest("초대 링크가 만료되었거나 이미 사용되었습니다.", "INVITE_INVALID");
  if (inv.email !== user.email) {
    throw forbidden(`이 초대는 ${maskEmail(inv.email)} 계정을 위한 것입니다. 해당 이메일로 로그인해주세요.`);
  }
  const already = await prisma.familyMember.findUnique({
    where: { familyId_userId: { familyId: inv.familyId, userId: user.id } },
  });
  if (already) throw conflict("이미 이 가족의 구성원입니다.");
  await prisma.$transaction((tx) => consumeInvitationInTx(tx, inv.id, user.id, inv.familyId, inv.role));
  return inv.family;
}

export async function listInvitations(user: AuthUser, familyId: string) {
  await requireFamilyAdmin(user, familyId);
  return prisma.invitation.findMany({
    where: { familyId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
      invitedBy: { select: { name: true } },
    },
  });
}

export async function revokeInvitation(user: AuthUser, invitationId: string) {
  const inv = await prisma.invitation.findUnique({ where: { id: invitationId } });
  if (!inv) throw notFound();
  await requireFamilyAdmin(user, inv.familyId);
  await prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
}

export function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
}
