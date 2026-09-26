import Link from "next/link";
import type { AlbumDTO } from "@/types";

export function AlbumCard({ album }: { album: AlbumDTO }) {
  return (
    <Link href={`/albums/${album.id}`} className="group block">
      <div className="aspect-[4/3] overflow-hidden rounded-2xl bg-gradient-to-br from-brand-100 to-amber-50 shadow-sm">
        {album.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={album.coverUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        ) : (
          <div className="flex h-full items-center justify-center text-4xl">📁</div>
        )}
      </div>
      <p className="mt-2 truncate px-1 font-semibold text-stone-800">{album.name}</p>
      <p className="px-1 text-xs text-stone-500">사진 {album.photoCount.toLocaleString()}장</p>
    </Link>
  );
}
