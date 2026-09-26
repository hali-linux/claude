import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireFamilyContext } from "@/lib/page-context";
import { photoQuerySchema } from "@/lib/validation";
import { toQueryString } from "@/lib/query-string";
import { listPhotos } from "@/services/photo-service";
import { listAlbums } from "@/services/album-service";
import { Gallery } from "@/components/gallery";
import { PhotoFilters } from "@/components/photo-filters";
import { PageHeader } from "@/components/section";

export const metadata: Metadata = { title: "사진" };

export default async function PhotosPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, family, isFamilyAdmin } = await requireFamilyContext();
  const raw = Object.fromEntries(Object.entries(await searchParams).filter((e): e is [string, string] => typeof e[1] === "string"));
  const parsed = photoQuerySchema.safeParse({ ...raw, cursor: undefined, familyId: undefined });
  const query = parsed.success ? parsed.data : photoQuerySchema.parse({});

  const [page, albums, members] = await Promise.all([
    listPhotos(user, family.id, query),
    listAlbums(user, family.id),
    prisma.familyMember.findMany({ where: { familyId: family.id }, select: { user: { select: { id: true, name: true } } } }),
  ]);
  const qs = toQueryString({
    familyId: family.id,
    q: query.q,
    albumId: query.albumId,
    uploaderId: query.uploaderId,
    dateField: query.dateField,
    preset: query.preset,
    from: query.from,
    to: query.to,
  });
  const filtered = !!(query.q || query.albumId || query.uploaderId || query.preset || query.from || query.to);

  return (
    <>
      <PageHeader title="사진" description={`${family.name}의 모든 사진`} />
      <PhotoFilters
        albums={albums.map((a) => ({ id: a.id, name: a.name }))}
        members={members.map((m) => m.user)}
        initial={{
          q: query.q ?? "",
          albumId: query.albumId ?? "",
          uploaderId: query.uploaderId ?? "",
          dateField: query.dateField,
          preset: query.preset ?? "",
          from: query.from ?? "",
          to: query.to ?? "",
        }}
      />
      <Gallery
        key={qs}
        initial={page}
        query={qs}
        context={{ albums: albums.map((a) => ({ id: a.id, name: a.name })), isFamilyAdmin }}
        emptyMessage={filtered ? "조건에 맞는 사진이 없어요. 검색 조건을 바꿔보세요." : "아직 사진이 없어요. 첫 사진을 올려보세요!"}
      />
    </>
  );
}
