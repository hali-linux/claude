import type { Metadata } from "next";
import { requireFamilyContext } from "@/lib/page-context";
import { photoQuerySchema } from "@/lib/validation";
import { toQueryString } from "@/lib/query-string";
import { listPhotos } from "@/services/photo-service";
import { listAlbums } from "@/services/album-service";
import { Gallery } from "@/components/gallery";
import { PageHeader } from "@/components/section";

export const metadata: Metadata = { title: "즐겨찾기" };

export default async function FavoritesPage() {
  const { user, family, isFamilyAdmin } = await requireFamilyContext();
  const [page, albums] = await Promise.all([
    listPhotos(user, family.id, photoQuerySchema.parse({ favorites: "1" })),
    listAlbums(user, family.id),
  ]);
  return (
    <>
      <PageHeader title="⭐ 즐겨찾기" description="내가 별표한 사진만 모아봤어요." />
      <Gallery
        initial={page}
        query={toQueryString({ familyId: family.id, favorites: "1" })}
        context={{ albums: albums.map((a) => ({ id: a.id, name: a.name })), isFamilyAdmin }}
        emptyMessage={
          <>
            <p className="text-4xl">⭐</p>
            <p className="mt-3">마음에 드는 사진을 열고 별 버튼을 눌러보세요.</p>
          </>
        }
      />
    </>
  );
}
