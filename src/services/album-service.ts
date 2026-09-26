import "server-only";
import { prisma } from "@/lib/db";
import { requireFamilyAdmin, requireMembership } from "@/lib/access";
import { badRequest, notFound } from "@/lib/errors";
import type { AuthUser } from "@/lib/session";
import type { AlbumDTO } from "@/types";
import { getStorage } from "./storage";

/**
 * 앨범 관리. 요구사항에 따라 앨범 생성/수정/삭제/대표사진 지정은 가족 관리자(ADMIN)만 가능하며,
 * 모든 구성원은 앨범을 조회하고 앨범에 사진을 업로드할 수 있다.
 */
async function coverUrl(album: { id: string; coverPhoto: { id: string; thumbKey: string; deletedAt: Date | null } | null; photos: { id: string; thumbKey: string }[] }) {
  const cover = album.coverPhoto && !album.coverPhoto.deletedAt ? album.coverPhoto : album.photos[0];
  if (!cover) return null;
  return (await getStorage().getSignedUrl(cover.thumbKey)) ?? `/api/photos/${cover.id}/image?v=thumb`;
}

const albumInclude = {
  coverPhoto: { select: { id: true, thumbKey: true, deletedAt: true } },
  photos: { where: { deletedAt: null }, orderBy: { createdAt: "desc" as const }, take: 1, select: { id: true, thumbKey: true } },
  _count: { select: { photos: { where: { deletedAt: null } } } },
};

export async function listAlbums(user: AuthUser, familyId: string, opts: { take?: number } = {}): Promise<AlbumDTO[]> {
  await requireMembership(user, familyId);
  const albums = await prisma.album.findMany({
    where: { familyId },
    orderBy: { updatedAt: "desc" },
    take: opts.take,
    include: albumInclude,
  });
  return Promise.all(
    albums.map(async (a) => ({
      id: a.id,
      familyId: a.familyId,
      name: a.name,
      description: a.description,
      photoCount: a._count.photos,
      coverUrl: await coverUrl(a),
      coverPhotoId: a.coverPhotoId,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  );
}

export async function getAlbum(user: AuthUser, albumId: string) {
  const a = await prisma.album.findUnique({ where: { id: albumId }, include: albumInclude });
  if (!a) throw notFound("앨범을 찾을 수 없습니다.");
  const m = await requireMembership(user, a.familyId).catch(() => {
    throw notFound("앨범을 찾을 수 없습니다.");
  });
  const dto: AlbumDTO = {
    id: a.id,
    familyId: a.familyId,
    name: a.name,
    description: a.description,
    photoCount: a._count.photos,
    coverUrl: await coverUrl(a),
    coverPhotoId: a.coverPhotoId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
  return { album: dto, membership: m };
}

export async function createAlbum(user: AuthUser, data: { familyId: string; name: string; description?: string | null }) {
  await requireFamilyAdmin(user, data.familyId);
  const album = await prisma.album.create({
    data: {
      familyId: data.familyId,
      name: data.name,
      description: data.description || null,
      createdById: user.id,
      activities: { create: { familyId: data.familyId, actorId: user.id, type: "ALBUM_CREATE" } },
    },
  });
  return album;
}

export async function updateAlbum(
  user: AuthUser,
  albumId: string,
  data: { name?: string; description?: string | null; coverPhotoId?: string | null },
) {
  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) throw notFound("앨범을 찾을 수 없습니다.");
  await requireMembership(user, album.familyId).catch(() => {
    throw notFound("앨범을 찾을 수 없습니다.");
  });
  await requireFamilyAdmin(user, album.familyId);
  if (data.coverPhotoId) {
    const photo = await prisma.photo.findUnique({ where: { id: data.coverPhotoId } });
    if (!photo || photo.familyId !== album.familyId || photo.deletedAt) throw notFound("사진을 찾을 수 없습니다.");
    if (photo.albumId !== album.id) throw badRequest("이 앨범에 있는 사진만 대표사진으로 지정할 수 있습니다.");
  }
  return prisma.album.update({
    where: { id: albumId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description || null } : {}),
      ...(data.coverPhotoId !== undefined ? { coverPhotoId: data.coverPhotoId } : {}),
    },
  });
}

/**
 * 앨범 삭제.
 * deletePhotos=false(기본): 사진은 "미분류"로 남는다.
 * deletePhotos=true: 앨범의 사진도 휴지통으로 이동한다(관리자가 복구 가능).
 */
export async function deleteAlbum(user: AuthUser, albumId: string, opts: { deletePhotos?: boolean } = {}) {
  const album = await prisma.album.findUnique({ where: { id: albumId } });
  if (!album) throw notFound("앨범을 찾을 수 없습니다.");
  await requireMembership(user, album.familyId).catch(() => {
    throw notFound("앨범을 찾을 수 없습니다.");
  });
  await requireFamilyAdmin(user, album.familyId);
  await prisma.$transaction(async (tx) => {
    if (opts.deletePhotos) {
      await tx.photo.updateMany({
        where: { albumId, deletedAt: null },
        data: { deletedAt: new Date(), deletedById: user.id },
      });
    }
    await tx.album.delete({ where: { id: albumId } });
  });
}
