import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireFamilyContext } from "@/lib/page-context";
import { photoQuerySchema } from "@/lib/validation";
import { timeAgo } from "@/lib/format";
import { listPhotos } from "@/services/photo-service";
import { listAlbums } from "@/services/album-service";
import { listRecentActivities } from "@/services/activity-service";
import { Gallery } from "@/components/gallery";
import { AlbumCard } from "@/components/album-card";
import { Section } from "@/components/section";
import { IconUpload } from "@/components/icons";

export default async function HomePage() {
  const { user, family, isFamilyAdmin } = await requireFamilyContext();
  const q = (extra: Record<string, string>) => photoQuerySchema.parse({ limit: 12, ...extra });

  const [recent, favorites, allAlbums, members, activities] = await Promise.all([
    listPhotos(user, family.id, q({})),
    listPhotos(user, family.id, q({ favorites: "1", limit: "6" })),
    listAlbums(user, family.id),
    prisma.familyMember.findMany({
      where: { familyId: family.id },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { joinedAt: "asc" },
    }),
    listRecentActivities(family.id, 8),
  ]);
  const albums = allAlbums.slice(0, 4);
  const context = { albums: allAlbums.map((a) => ({ id: a.id, name: a.name })), isFamilyAdmin };

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-400 to-rose-400 p-6 text-white shadow-md sm:p-8">
        <p className="text-sm font-medium opacity-90">{family.name}</p>
        <h1 className="mt-1 text-2xl font-bold sm:text-3xl">우리 가족의 추억</h1>
        <p className="mt-2 text-sm opacity-90">{user.name}님, 오늘의 순간을 가족과 나눠보세요.</p>
        <Link href="/upload" className="btn mt-5 bg-white text-brand-700 shadow hover:bg-brand-50">
          <IconUpload /> 사진 업로드
        </Link>
        <span className="pointer-events-none absolute -bottom-6 -right-4 text-[7rem] opacity-20 sm:text-[9rem]" aria-hidden>
          📷
        </span>
      </section>

      <Section title="최근 사진" href="/photos">
        <Gallery
          initial={{ items: recent.items, nextCursor: null }}
          query=""
          infinite={false}
          context={context}
          emptyMessage={
            <>
              <p className="text-4xl">🌱</p>
              <p className="mt-3">아직 사진이 없어요. 첫 번째 가족 사진을 올려보세요!</p>
              <Link href="/upload" className="btn-primary mt-4">사진 올리기</Link>
            </>
          }
        />
      </Section>

      <Section title="최근 앨범" href="/albums">
        {albums.length === 0 ? (
          <div className="card p-6 text-center text-sm text-stone-500">
            아직 앨범이 없어요.{isFamilyAdmin && <> <Link href="/albums" className="text-brand-600 underline">앨범 만들기</Link></>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {albums.map((a) => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
        )}
      </Section>

      {favorites.items.length > 0 && (
        <Section title="⭐ 즐겨찾기" href="/favorites">
          <Gallery initial={{ items: favorites.items, nextCursor: null }} query="" infinite={false} context={context} />
        </Section>
      )}

      <div className="grid gap-8 md:grid-cols-2">
        <Section title="가족 구성원" href="/family" linkLabel="가족 보기">
          <ul className="card flex flex-wrap gap-4 p-4">
            {members.map((m) => (
              <li key={m.id} className="flex w-16 flex-col items-center text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-lg font-bold text-brand-700">
                  {m.user.name.slice(0, 1)}
                </span>
                <span className="mt-1 w-full truncate text-xs text-stone-700">{m.user.name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="최근 활동">
          <ul className="card divide-y divide-stone-100">
            {activities.length === 0 && <li className="p-4 text-sm text-stone-500">아직 활동이 없어요.</li>}
            {activities.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 p-3.5 text-sm">
                <span className="min-w-0 text-stone-700">
                  <b>{a.actor?.name ?? "누군가"}</b>님이{" "}
                  {a.type === "PHOTO_UPLOAD" && (
                    <>
                      {a.album ? (
                        <Link href={`/albums/${a.album.id}`} className="text-brand-700 hover:underline">
                          {a.album.name}
                        </Link>
                      ) : (
                        "사진첩"
                      )}
                      에 사진 {a.count}장을 올렸어요 📷
                    </>
                  )}
                  {a.type === "ALBUM_CREATE" && (
                    <>
                      새 앨범{" "}
                      {a.album ? (
                        <Link href={`/albums/${a.album.id}`} className="text-brand-700 hover:underline">
                          {a.album.name}
                        </Link>
                      ) : (
                        ""
                      )}
                      을 만들었어요 📁
                    </>
                  )}
                  {a.type === "MEMBER_JOIN" && <>가족이 되었어요 🎉</>}
                </span>
                <time className="shrink-0 text-xs text-stone-400" dateTime={a.updatedAt.toISOString()}>
                  {timeAgo(a.updatedAt)}
                </time>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
