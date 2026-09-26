import { api } from "@/lib/http";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { requireUser } from "@/lib/session";
import { streamAlbumZip } from "@/services/zip-service";

type Ctx = { params: Promise<{ id: string }> };

/** 앨범 전체 ZIP 다운로드 (스트리밍, 분할) */
export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  rateLimit(`zip:${user.id}`, RULES.zip);
  const { id } = await params;
  const part = Math.max(1, Number(req.nextUrl.searchParams.get("part")) || 1);
  const { stream, fileName } = await streamAlbumZip(user, id, part);
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="album.zip"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}, { fallbackMessage: "ZIP 파일을 만들지 못했습니다. 잠시 후 다시 시도해주세요." });
