import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { api } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { getImageAccess, type ImageVariant } from "@/services/photo-service";
import { getStorage } from "@/services/storage";

type Ctx = { params: Promise<{ id: string }> };

const VARIANTS: ImageVariant[] = ["thumb", "large", "original"];

/**
 * 인증된 이미지 제공 엔드포인트.
 * 요청마다 로그인 + 가족 구성원 여부를 검사하므로, URL을 알아도 권한이 없으면 볼 수 없다.
 *  - 로컬 저장소: 파일을 직접 스트리밍
 *  - S3: 짧게 유효한 Presigned URL로 리다이렉트(서버 대역폭 절약)
 */
export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const v = req.nextUrl.searchParams.get("v") as ImageVariant;
  const variant: ImageVariant = VARIANTS.includes(v) ? v : "large";
  const download = req.nextUrl.searchParams.get("download") === "1";

  const { key, mime, downloadName } = await getImageAccess(user, id, variant);
  const storage = getStorage();

  const signed = await storage.getSignedUrl(key, download ? { downloadName } : {});
  if (signed) {
    const res = NextResponse.redirect(signed, 302);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  const { stream, size } = await storage.getStream(key);
  const headers = new Headers({
    "Content-Type": mime,
    // 사용자 브라우저에만 캐시(공유 캐시/CDN에는 저장 금지). 로그인 사용자 본인의 기기에만 남는다.
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    // 이미지 응답이 문서로 해석되더라도 스크립트가 실행되지 않도록 샌드박스 처리
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="photo"; filename*=UTF-8''${encodeURIComponent(
      variant === "original" ? downloadName : downloadName.replace(/\.[^.]+$/, "") + ".webp",
    )}`,
  });
  if (size !== undefined) headers.set("Content-Length", String(size));
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { headers });
});
