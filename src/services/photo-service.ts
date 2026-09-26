import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { canModifyPhoto, getMembership, requireFamilyAdmin, requireMembership, type Membership } from "@/lib/access";
import { badRequest, forbidden, notFound, payloadTooLarge, unsupportedMedia } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { AuthUser } from "@/lib/session";
import { isAllowedDeclaredMime, isAllowedExtension } from "@/lib/upload-rules";
import { resolveDateRange, type PhotoQuery } from "@/lib/validation";
import type { Prisma } from "@/generated/prisma/client";
import type { PhotoDTO } from "@/types";
import { getStorage } from "./storage";
import { processImage } from "./image";
import { recordUploadActivity } from "./activity-service";

const photoInclude = {
  uploader: { select: { id: true, name: true } },
  album: { select: { id: true, name: true } },
} satisfies Prisma.PhotoInclude;

type PhotoWithRelations = Prisma.PhotoGetPayload<{ include: typeof photoInclude }>;

export type ImageVariant = "thumb" | "large" | "original";

/** 이미지 URL 생성: S3면 짧게 유효한 서명 URL, 로컬이면 인증 검사 API 경로 */
async function imageUrl(p: { id: string; thumbKey: string; largeKey: string }, variant: "thumb" | "large") {
  const signed = await getStorage().getSignedUrl(variant === "thumb" ? p.thumbKey : p.largeKey);
  return signed ?? `/api/photos/${p.id}/image?v=${variant}`;
}

export async function toPhotoDTO(p: PhotoWithRelations, m: Membership, favorite: boolean): Promise<PhotoDTO> {
  const [thumbUrl, largeUrl] = await Promise.all([imageUrl(p, "thumb"), imageUrl(p, "large")]);
  return {
    id: p.id,
    familyId: p.familyId,
    originalName: p.originalName,
    description: p.description,
    mimeType: p.mimeType,
    sizeBytes: p.sizeBytes,
    width: p.width,
    height: p.height,
    takenAt: p.takenAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    deletedAt: p.deletedAt?.toISOString() ?? null,
    uploader: p.uploader,
    album: p.album,
    thumbUrl,
    largeUrl,
    downloadUrl: `/api/photos/${p.id}/image?v=original&download=1`,
    isFavorite: favorite,
    canModify: canModifyPhoto(m, p),
  };
}

async function toDTOs(photos: PhotoWithRelations[], user: AuthUser, m: Membership) {
  const favs = await prisma.favorite.findMany({
    where: { userId: user.id, photoId: { in: photos.map((p) => p.id) } },
    select: { photoId: true },
  });
  const favSet = new Set(favs.map((f) => f.photoId));
  return Promise.all(photos.map((p) => toPhotoDTO(p, m, favSet.has(p.id))));
}

/** 사진을 조회하고 권한을 확인한다. 다른 가족의 사진이면 404(IDOR 방지) */
async function loadPhotoForUser(user: AuthUser, photoId: string, opts: { includeDeleted?: boolean } = {}) {
  const photo = await prisma.photo.findUnique({ where: { id: photoId }, include: photoInclude });
  if (!photo) throw notFound("사진을 찾을 수 없습니다.");
  const m = await getMembership(user.id, photo.familyId);
  if (!m) throw notFound("사진을 찾을 수 없습니다.");
  // 휴지통 사진은 가족 관리자만 접근 가능
  if (photo.deletedAt && !(opts.includeDeleted && m.role === "ADMIN")) throw notFound("사진을 찾을 수 없습니다.");
  return { photo, m };
}

// ─────────────────────────────── 업로드 ───────────────────────────────

export interface UploadInput {
  familyId: string;
  albumId?: string | null;
  file: File;
}

export async function uploadPhoto(user: AuthUser, input: UploadInput) {
  const m = await requireMembership(user, input.familyId);
  const { file } = input;
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;

  // 1) 크기/확장자/선언된 MIME 1차 검증 (실제 내용 검증은 processImage에서 매직 바이트로 수행)
  if (file.size === 0) throw badRequest("빈 파일입니다.");
  if (file.size > maxBytes) throw payloadTooLarge(`사진 한 장의 크기는 ${env().MAX_UPLOAD_MB}MB 이하여야 합니다.`);
  const originalName = sanitizeFileName(file.name);
  if (!isAllowedExtension(originalName) || !isAllowedDeclaredMime(file.type)) {
    throw unsupportedMedia("지원하지 않는 파일 형식입니다. JPG, PNG, WEBP, GIF, AVIF, HEIC 사진만 올릴 수 있습니다.");
  }

  let albumId: string | null = null;
  if (input.albumId) {
    const album = await prisma.album.findUnique({ where: { id: input.albumId }, select: { familyId: true } });
    // 앨범이 다른 가족 소속이면 존재하지 않는 것으로 취급
    if (!album || album.familyId !== m.familyId) throw notFound("앨범을 찾을 수 없습니다.");
    albumId = input.albumId;
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > maxBytes) throw payloadTooLarge(`사진 한 장의 크기는 ${env().MAX_UPLOAD_MB}MB 이하여야 합니다.`);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  // 2) 중복 업로드 감지: 네트워크 오류 후 재시도해도 같은 사진이 두 번 저장되지 않는다(멱등성).
  const dup = await prisma.photo.findFirst({
    where: { familyId: m.familyId, sha256, deletedAt: null },
    include: photoInclude,
  });
  if (dup) return { photo: await toPhotoDTO(dup, m, false), duplicate: true };

  // 3) 이미지 검증 + 썸네일/대형 이미지 생성
  const img = await processImage(buf);

  // 4) 저장소에 업로드. 키는 추측 불가능한 UUID를 포함한다.
  const now = new Date();
  const prefix = `families/${m.familyId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}`;
  const keys = {
    originalKey: `${prefix}/original.${img.ext}`,
    largeKey: `${prefix}/large.webp`,
    thumbKey: `${prefix}/thumb.webp`,
  };
  const storage = getStorage();
  try {
    await Promise.all([
      storage.put(keys.originalKey, buf, { contentType: img.mime }),
      storage.put(keys.largeKey, img.large, { contentType: "image/webp" }),
      storage.put(keys.thumbKey, img.thumb, { contentType: "image/webp" }),
    ]);
  } catch (err) {
    await storage.delete(Object.values(keys)).catch(() => {});
    throw err;
  }

  // 5) DB 기록. 실패하면 저장소에 올린 파일을 정리해 고아 파일이 남지 않게 한다.
  try {
    const photo = await prisma.$transaction(async (tx) => {
      const created = await tx.photo.create({
        data: {
          familyId: m.familyId,
          albumId,
          uploaderId: user.id,
          originalName,
          mimeType: img.mime,
          sizeBytes: buf.length,
          storageBytes: buf.length + img.large.length + img.thumb.length,
          width: img.width,
          height: img.height,
          takenAt: img.takenAt,
          sha256,
          ...keys,
        },
        include: photoInclude,
      });
      await recordUploadActivity(tx, m.familyId, user.id, albumId);
      return created;
    });
    return { photo: await toPhotoDTO(photo, m, false), duplicate: false };
  } catch (err) {
    await storage.delete(Object.values(keys)).catch((e) => logger.warn("고아 파일 정리 실패", { err: e }));
    throw err;
  }
}

/** 파일명에서 경로/제어문자를 제거한다(표시용으로만 사용하며 저장 키에는 사용하지 않음). */
export function sanitizeFileName(name: string) {
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  return (base || "photo").slice(0, 200);
}

// ─────────────────────────────── 조회/검색 ───────────────────────────────

export async function listPhotos(user: AuthUser, familyId: string, q: PhotoQuery) {
  const m = await requireMembership(user, familyId);

  const where: Prisma.PhotoWhereInput = { familyId, deletedAt: null };
  if (q.albumId === "none") where.albumId = null;
  else if (q.albumId) where.albumId = q.albumId;
  if (q.uploaderId) where.uploaderId = q.uploaderId;
  if (q.favorites) where.favorites = { some: { userId: user.id } };
  if (q.q) {
    const contains = { contains: q.q, mode: "insensitive" as const };
    where.OR = [
      { description: contains },
      { originalName: contains },
      { album: { name: contains } },
      { uploader: { name: contains } },
    ];
  }
  const range = resolveDateRange(q.preset, q.from, q.to);
  if (range) where[q.dateField === "taken" ? "takenAt" : "createdAt"] = range;

  const rows = await prisma.photo.findMany({
    where,
    include: photoInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  return { items: await toDTOs(page, user, m), nextCursor: hasMore ? page[page.length - 1]!.id : null };
}

export async function getPhoto(user: AuthUser, photoId: string) {
  const { photo, m } = await loadPhotoForUser(user, photoId);
  const fav = await prisma.favorite.findUnique({ where: { userId_photoId: { userId: user.id, photoId } } });
  return toPhotoDTO(photo, m, !!fav);
}

export async function updatePhoto(
  user: AuthUser,
  photoId: string,
  data: { description?: string | null; albumId?: string | null; takenAt?: Date | null },
) {
  const { photo, m } = await loadPhotoForUser(user, photoId);
  if (!canModifyPhoto(m, photo)) throw forbidden("자신이 올린 사진만 수정할 수 있습니다.");
  if (data.albumId) {
    const album = await prisma.album.findUnique({ where: { id: data.albumId }, select: { familyId: true } });
    if (!album || album.familyId !== photo.familyId) throw notFound("앨범을 찾을 수 없습니다.");
  }
  const updated = await prisma.photo.update({
    where: { id: photoId },
    data: {
      ...(data.description !== undefined ? { description: data.description || null } : {}),
      ...(data.albumId !== undefined ? { albumId: data.albumId } : {}),
      ...(data.takenAt !== undefined ? { takenAt: data.takenAt } : {}),
    },
    include: photoInclude,
  });
  const fav = await prisma.favorite.findUnique({ where: { userId_photoId: { userId: user.id, photoId } } });
  return toPhotoDTO(updated, m, !!fav);
}

/** Soft Delete: 휴지통으로 이동(관리자가 복구 가능) */
export async function softDeletePhoto(user: AuthUser, photoId: string) {
  const { photo, m } = await loadPhotoForUser(user, photoId);
  if (!canModifyPhoto(m, photo)) throw forbidden("자신이 올린 사진만 삭제할 수 있습니다.");
  await prisma.photo.update({ where: { id: photoId }, data: { deletedAt: new Date(), deletedById: user.id } });
}

export async function restorePhoto(user: AuthUser, photoId: string) {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) throw notFound();
  await requireFamilyAdmin(user, photo.familyId);
  if (!photo.deletedAt) return;
  await prisma.photo.update({ where: { id: photoId }, data: { deletedAt: null, deletedById: null } });
}

/** 영구 삭제: 휴지통에 있는 사진만, 가족 관리자만 가능 */
export async function permanentlyDeletePhoto(user: AuthUser, photoId: string) {
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!photo) throw notFound();
  await requireFamilyAdmin(user, photo.familyId);
  if (!photo.deletedAt) throw badRequest("먼저 사진을 휴지통으로 이동해주세요.");
  await hardDelete([photo]);
}

async function hardDelete(photos: Array<{ id: string; originalKey: string; largeKey: string; thumbKey: string }>) {
  if (photos.length === 0) return 0;
  // DB를 먼저 지워 사용자에게 즉시 보이지 않게 하고, 저장소 파일은 이후 정리한다.
  await prisma.photo.deleteMany({ where: { id: { in: photos.map((p) => p.id) } } });
  await getStorage()
    .delete(photos.flatMap((p) => [p.originalKey, p.largeKey, p.thumbKey]))
    .catch((err) => logger.error("저장소 파일 삭제 실패", { err, count: photos.length }));
  return photos.length;
}

/** 보관 기간이 지난 휴지통 사진을 영구 삭제 (관리자 버튼 또는 cron 스크립트에서 호출) */
export async function purgeTrash(opts: { familyId?: string; olderThanDays?: number } = {}) {
  const days = opts.olderThanDays ?? env().TRASH_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const batch = await prisma.photo.findMany({
      where: { deletedAt: { lte: cutoff }, ...(opts.familyId ? { familyId: opts.familyId } : {}) },
      select: { id: true, originalKey: true, largeKey: true, thumbKey: true },
      take: 200,
    });
    if (batch.length === 0) break;
    total += await hardDelete(batch);
  }
  return total;
}

export async function listTrash(user: AuthUser, familyId: string) {
  const m = await requireFamilyAdmin(user, familyId);
  const rows = await prisma.photo.findMany({
    where: { familyId, deletedAt: { not: null } },
    include: { ...photoInclude, deletedBy: { select: { name: true } } },
    orderBy: { deletedAt: "desc" },
    take: 200,
  });
  return Promise.all(
    rows.map(async (p) => ({ ...(await toPhotoDTO(p, m, false)), deletedByName: p.deletedBy?.name ?? null })),
  );
}

// ─────────────────────────────── 즐겨찾기 ───────────────────────────────

export async function setFavorite(user: AuthUser, photoId: string, on: boolean) {
  await loadPhotoForUser(user, photoId);
  if (on) {
    await prisma.favorite.upsert({
      where: { userId_photoId: { userId: user.id, photoId } },
      create: { userId: user.id, photoId },
      update: {},
    });
  } else {
    await prisma.favorite.deleteMany({ where: { userId: user.id, photoId } });
  }
}

// ─────────────────────────────── 이미지 제공 ───────────────────────────────

/** 이미지 파일 접근 전 권한 검사 후 저장소 키를 반환 */
export async function getImageAccess(user: AuthUser, photoId: string, variant: ImageVariant) {
  const { photo } = await loadPhotoForUser(user, photoId, { includeDeleted: true });
  const key = variant === "thumb" ? photo.thumbKey : variant === "large" ? photo.largeKey : photo.originalKey;
  const mime = variant === "original" ? photo.mimeType : "image/webp";
  return { key, mime, downloadName: photo.originalName };
}
