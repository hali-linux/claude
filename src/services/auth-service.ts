import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { conflict, forbidden, unauthorized, badRequest } from "@/lib/errors";
import { dummyVerify, hashPassword, verifyPassword } from "@/lib/password";
import { revokeOtherSessions } from "@/lib/session";
import type { z } from "zod";
import type { registerSchema } from "@/lib/validation";
import { consumeInvitationInTx, findValidInvitation } from "./invitation-service";
import { Prisma } from "@/generated/prisma/client";

type RegisterInput = z.infer<typeof registerSchema>;

/**
 * 회원가입 정책
 *  - 초대 링크로 가입: 초대받은 이메일과 일치해야 하며, 가입과 동시에 가족 그룹에 참여한다.
 *  - 초대 없이 가입: 최초 사용자(서비스 관리자) 또는 ALLOW_OPEN_REGISTRATION=true 인 경우에만 허용.
 *    이 경우 새 가족 그룹이 만들어지고 가입자가 해당 가족의 관리자가 된다.
 */
export async function registerUser(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  try {
    if (input.inviteToken) {
      const inv = await findValidInvitation(input.inviteToken);
      if (!inv) throw badRequest("초대 링크가 만료되었거나 이미 사용되었습니다.", "INVITE_INVALID");
      if (inv.email !== input.email) {
        throw forbidden("초대받은 이메일 주소로만 가입할 수 있습니다.");
      }
      return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { name: input.name, email: input.email, passwordHash },
        });
        await consumeInvitationInTx(tx, inv.id, user.id, inv.familyId, inv.role);
        return user;
      });
    }

    return await prisma.$transaction(
      async (tx) => {
        const userCount = await tx.user.count();
        const isFirstUser = userCount === 0;
        if (!isFirstUser && !env().ALLOW_OPEN_REGISTRATION) {
          throw forbidden("가족 관리자에게 받은 초대 링크로만 가입할 수 있습니다.");
        }
        const user = await tx.user.create({
          data: {
            name: input.name,
            email: input.email,
            passwordHash,
            role: isFirstUser ? "ADMIN" : "MEMBER",
          },
        });
        await tx.family.create({
          data: {
            name: input.familyName || `${input.name}님의 가족`,
            members: { create: { userId: user.id, role: "ADMIN" } },
            activities: { create: { actorId: user.id, type: "MEMBER_JOIN" } },
          },
        });
        return user;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw conflict("이미 가입된 이메일입니다. 로그인해주세요.");
    }
    throw err;
  }
}

const INVALID_LOGIN = "이메일 또는 비밀번호가 올바르지 않습니다.";

export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await dummyVerify(password); // 타이밍 공격으로 가입 여부를 알 수 없게 한다
    throw unauthorized(INVALID_LOGIN);
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized(INVALID_LOGIN);
  return user;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, keepToken?: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw badRequest("현재 비밀번호가 올바르지 않습니다.", "WRONG_PASSWORD");
  }
  if (currentPassword === newPassword) throw badRequest("새 비밀번호가 현재 비밀번호와 같습니다.");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
  // 비밀번호 변경 시 현재 기기를 제외한 모든 세션을 로그아웃시킨다(탈취된 세션 무효화).
  await revokeOtherSessions(userId, keepToken);
}
