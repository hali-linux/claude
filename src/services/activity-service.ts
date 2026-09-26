import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * 사진 업로드 활동 기록. 같은 사람이 같은 앨범에 30분 안에 연속으로 올리면
 * 새 활동을 만들지 않고 count를 증가시켜 "엄마님이 사진 12장을 올렸습니다"처럼 묶어서 보여준다.
 */
export async function recordUploadActivity(tx: Tx, familyId: string, actorId: string, albumId: string | null) {
  // 여러 장이 동시에 업로드될 때 각 요청이 "최근 활동 없음"으로 판단해 중복 생성하지 않도록
  // (가족+사용자) 단위의 트랜잭션 범위 advisory lock으로 직렬화한다. (파라미터 바인딩 사용)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`activity:${familyId}:${actorId}`}))`;
  const recent = await tx.activity.findFirst({
    where: {
      familyId,
      actorId,
      albumId,
      type: "PHOTO_UPLOAD",
      updatedAt: { gte: new Date(Date.now() - 30 * 60_000) },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  if (recent) {
    await tx.activity.update({ where: { id: recent.id }, data: { count: { increment: 1 } } });
  } else {
    await tx.activity.create({ data: { familyId, actorId, albumId, type: "PHOTO_UPLOAD" } });
  }
}

export async function listRecentActivities(familyId: string, take = 10) {
  return prisma.activity.findMany({
    where: { familyId },
    orderBy: { updatedAt: "desc" },
    take,
    include: { actor: { select: { name: true } }, album: { select: { id: true, name: true } } },
  });
}
