import type { Metadata } from "next";
import { env } from "@/lib/env";
import { requireFamilyContext } from "@/lib/page-context";
import { listAlbums } from "@/services/album-service";
import { Uploader } from "@/components/uploader";
import { PageHeader } from "@/components/section";

export const metadata: Metadata = { title: "사진 올리기" };

export default async function UploadPage({ searchParams }: { searchParams: Promise<{ albumId?: string }> }) {
  const { user, family } = await requireFamilyContext();
  const { albumId } = await searchParams;
  const albums = await listAlbums(user, family.id);
  const valid = albums.some((a) => a.id === albumId) ? albumId : undefined;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="사진 올리기" description={`${family.name} 사진첩에 추억을 더해보세요.`} />
      <Uploader
        familyId={family.id}
        albums={albums.map((a) => ({ id: a.id, name: a.name }))}
        defaultAlbumId={valid}
        maxUploadMb={env().MAX_UPLOAD_MB}
      />
    </div>
  );
}
