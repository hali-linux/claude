import type { Metadata } from "next";
import { requireFamilyContext } from "@/lib/page-context";
import { listAlbums } from "@/services/album-service";
import { AlbumCard } from "@/components/album-card";
import { PageHeader } from "@/components/section";
import { CreateAlbumButton } from "@/components/album/album-form";

export const metadata: Metadata = { title: "앨범" };

export default async function AlbumsPage() {
  const { user, family, isFamilyAdmin } = await requireFamilyContext();
  const albums = await listAlbums(user, family.id);
  return (
    <>
      <PageHeader
        title="앨범"
        description={`앨범 ${albums.length}개`}
        actions={isFamilyAdmin ? <CreateAlbumButton familyId={family.id} /> : undefined}
      />
      {albums.length === 0 ? (
        <div className="card p-10 text-center text-stone-500">
          <p className="text-4xl">📁</p>
          <p className="mt-3">
            아직 앨범이 없어요.
            {isFamilyAdmin ? " '새 앨범' 버튼으로 첫 앨범을 만들어보세요." : " 가족 관리자에게 앨범을 만들어 달라고 해보세요."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
          {albums.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </div>
      )}
    </>
  );
}
