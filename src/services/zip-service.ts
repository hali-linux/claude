import "server-only";
import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { requireMembership } from "@/lib/access";
import { conflict, notFound, badRequest } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { AuthUser } from "@/lib/session";
import { getStorage } from "./storage";

/**
 * 앨범 ZIP 다운로드 (서버 부하 최소화 설계)
 *
 *  - 스트리밍: ZIP 전체를 메모리/디스크에 만들지 않고, 사진을 한 장씩 읽어 바로 응답으로 흘려보낸다.
 *    → 메모리 사용량이 사진 수와 무관하게 일정하다.
 *  - 무압축(store): JPEG/HEIC는 이미 압축되어 있어 재압축해도 용량이 거의 줄지 않고 CPU만 소모한다.
 *  - 분할 다운로드: 한 ZIP에 최대 MAX_ZIP_PHOTOS장(기본 300장). 사진이 많으면 part=2,3... 로 나누어 받는다.
 *  - 동시 실행 제한: 사용자당 동시에 1개의 ZIP만 생성 + Rate Limit.
 *  - 순차 처리: 다음 사진은 이전 사진이 ZIP에 기록된 뒤에야 저장소에서 읽기 시작한다.
 *
 * 사진이 수만 장 규모로 커지면 백그라운드 작업(SQS + Lambda 등)으로 ZIP을 만들어 S3에 올리고
 * Presigned URL을 이메일로 보내는 방식으로 확장할 수 있다(README 참고).
 */
const activeZips = new Set<string>();

export async function getAlbumZipInfo(user: AuthUser, albumId: string) {
  const album = await prisma.album.findUnique({ where: { id: albumId }, select: { id: true, name: true, familyId: true } });
  if (!album) throw notFound("앨범을 찾을 수 없습니다.");
  await requireMembership(user, album.familyId).catch(() => {
    throw notFound("앨범을 찾을 수 없습니다.");
  });
  const count = await prisma.photo.count({ where: { albumId, deletedAt: null } });
  const perPart = env().MAX_ZIP_PHOTOS;
  return { album, count, perPart, parts: Math.max(1, Math.ceil(count / perPart)) };
}

export async function streamAlbumZip(user: AuthUser, albumId: string, part: number) {
  const info = await getAlbumZipInfo(user, albumId);
  if (info.count === 0) throw badRequest("앨범에 사진이 없습니다.");
  if (part < 1 || part > info.parts) throw badRequest("잘못된 요청입니다.");
  if (activeZips.has(user.id)) throw conflict("이미 다른 ZIP 파일을 내려받는 중입니다. 완료 후 다시 시도해주세요.");

  const photos = await prisma.photo.findMany({
    where: { albumId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (part - 1) * info.perPart,
    take: info.perPart,
    select: { id: true, originalKey: true, originalName: true },
  });

  activeZips.add(user.id);
  const archive = archiver("zip", { store: true });
  const out = new PassThrough();
  archive.pipe(out);
  const release = () => activeZips.delete(user.id);
  out.on("close", release);
  out.on("end", release);
  out.on("error", release);
  archive.on("warning", (err) => logger.warn("ZIP 경고", { err }));
  archive.on("error", (err) => {
    logger.error("ZIP 생성 실패", { err, albumId });
    out.destroy(err);
  });

  const usedNames = new Set<string>();
  const uniqueName = (name: string) => {
    let n = name;
    let i = 1;
    const dot = name.lastIndexOf(".");
    while (usedNames.has(n.toLowerCase())) {
      n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
      i++;
    }
    usedNames.add(n.toLowerCase());
    return n;
  };

  // 사진을 한 장씩 순차적으로 추가 (저장소 동시 연결 수 = 1)
  (async () => {
    const storage = getStorage();
    for (const p of photos) {
      if (out.destroyed) break; // 사용자가 다운로드를 취소함
      try {
        const { stream } = await storage.getStream(p.originalKey);
        const done = new Promise<void>((resolve) => archive.once("entry", () => resolve()));
        archive.append(stream, { name: uniqueName(p.originalName) });
        await done;
      } catch (err) {
        logger.warn("ZIP: 사진 파일 누락", { photoId: p.id, err });
      }
    }
    await archive.finalize();
  })().catch((err) => {
    logger.error("ZIP 스트리밍 실패", { err });
    out.destroy(err as Error);
  });

  const suffix = info.parts > 1 ? `_${part}` : "";
  return {
    stream: Readable.toWeb(out) as ReadableStream<Uint8Array>,
    fileName: `${info.album.name}${suffix}.zip`,
  };
}
