import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError } from "@/lib/errors";
import { requireFamilyContext } from "@/lib/page-context";
import { photoQuerySchema } from "@/lib/validation";
import { toQueryString } from "@/lib/query-string";
import { getAlbum, listAlbums } from "@/services/album-service";
import { listPhotos } from "@/services/photo-service";
import { getAlbumZipInfo } from "@/services/zip-service";
import { Gallery } from "@/components/gallery";
import { AlbumActions } from "@/components/album/album-actions";
import { IconUpload } from "@/components/icons";

export const metadata: Metadata = { title: "앨범" };

export default async function AlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, isFamilyAdmin } = await requireFamilyContext();
  let data;
  try {
    data = await getAlbum(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const { album } = data;
  const [page, albums, zip] = await Promise.all([
    listPhotos(user, album.familyId, photoQuerySchema.parse({ albumId: album.id })),
    listAlbums(user, album.familyId),
    getAlbumZipInfo(user, album.id),
  ]);
  const canAdmin = data.membership.role === "ADMIN";

  return (
    <>
      <div className="mb-5 space-y-3 px-1">
        <Link href="/albums" className="text-sm text-stone-500 hover:text-stone-800">
          ← 앨범 목록
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-stone-900">{album.name}</h1>
            {album.description && <p className="mt-1 whitespace-pre-line text-sm text-stone-600">{album.description}</p>}
            <p className="mt-1 text-xs text-stone-400">사진 {album.photoCount.toLocaleString()}장</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/upload?albumId=${album.id}`} className="btn-primary">
              <IconUpload /> 이 앨범에 올리기
            </Link>
            <AlbumActions album={album} canAdmin={canAdmin} zipParts={zip.parts} perPart={zip.perPart} />
          </div>
        </div>
      </div>
      <Gallery
        initial={page}
        query={toQueryString({ familyId: album.familyId, albumId: album.id })}
        context={{
          albums: albums.map((a) => ({ id: a.id, name: a.name })),
          isFamilyAdmin: isFamilyAdmin && canAdmin,
          album: { id: album.id, coverPhotoId: album.coverPhotoId },
        }}
        emptyMessage={
          <>
            <p className="text-4xl">🖼️</p>
            <p className="mt-3">이 앨범에는 아직 사진이 없어요.</p>
          </>
        }
      />
    </>
  );
}
