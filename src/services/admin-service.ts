import "server-only";
import { prisma } from "@/lib/db";
import { requireFamilyAdmin } from "@/lib/access";
import type { AuthUser } from "@/lib/session";

/** 관리자 대시보드 통계 (가족 단위) */
export async function getFamilyStats(user: AuthUser, familyId: string) {
  await requireFamilyAdmin(user, familyId);
  const [photoAgg, trashAgg, members, albums, byUploader] = await Promise.all([
    prisma.photo.aggregate({ where: { familyId, deletedAt: null }, _count: true, _sum: { storageBytes: true } }),
    prisma.photo.aggregate({ where: { familyId, deletedAt: { not: null } }, _count: true, _sum: { storageBytes: true } }),
    prisma.familyMember.count({ where: { familyId } }),
    prisma.album.count({ where: { familyId } }),
    prisma.photo.groupBy({
      by: ["uploaderId"],
      where: { familyId, deletedAt: null },
      _count: { _all: true },
      _sum: { storageBytes: true },
      _max: { createdAt: true },
    }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: byUploader.map((b) => b.uploaderId).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return {
    photoCount: photoAgg._count,
    storageBytes: Number(photoAgg._sum.storageBytes ?? 0) + Number(trashAgg._sum.storageBytes ?? 0),
    trashCount: trashAgg._count,
    memberCount: members,
    albumCount: albums,
    uploaders: byUploader
      .map((b) => ({
        userId: b.uploaderId,
        name: b.uploaderId ? (nameOf.get(b.uploaderId) ?? "알 수 없음") : "탈퇴한 사용자",
        photoCount: b._count._all,
        storageBytes: Number(b._sum.storageBytes ?? 0),
        lastUploadAt: b._max.createdAt?.toISOString() ?? null,
      }))
      .sort((a, b) => b.photoCount - a.photoCount),
  };
}
