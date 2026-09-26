import { env } from "@/lib/env";
import { badRequest, payloadTooLarge } from "@/lib/errors";
import { api, json } from "@/lib/http";
import { familyIdFor } from "@/lib/family-context";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { requireUser } from "@/lib/session";
import { idSchema } from "@/lib/validation";
import { uploadPhoto } from "@/services/photo-service";

/**
 * 사진 업로드 (multipart/form-data, 요청당 사진 1장)
 *
 * 한 요청에 한 장씩 올리는 이유
 *  - 파일별 진행률/성공/실패를 정확히 표시하고 실패한 사진만 다시 올릴 수 있다.
 *  - 요청 하나가 너무 커져 타임아웃되거나 서버 메모리를 과도하게 쓰는 것을 방지한다.
 * 클라이언트는 여러 장을 동시에(기본 3개씩) 병렬 업로드한다.
 */
export const POST = api(async (req) => {
  const user = await requireUser(req);
  rateLimit(`upload:${user.id}`, RULES.upload);

  // 본문을 읽기 전에 Content-Length로 과도한 요청을 조기 차단
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes + 64 * 1024) {
    throw payloadTooLarge(`사진 한 장의 크기는 ${env().MAX_UPLOAD_MB}MB 이하여야 합니다.`);
  }
  if (!req.headers.get("content-type")?.startsWith("multipart/form-data")) throw badRequest();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw badRequest("업로드 요청을 읽지 못했습니다. 다시 시도해주세요.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("업로드할 사진이 없습니다.");
  const rawFamily = form.get("familyId");
  const rawAlbum = form.get("albumId");
  const familyId = await familyIdFor(req, user, typeof rawFamily === "string" && rawFamily ? idSchema.parse(rawFamily) : null);
  const albumId = typeof rawAlbum === "string" && rawAlbum ? idSchema.parse(rawAlbum) : null;

  const result = await uploadPhoto(user, { familyId, albumId, file });
  return json(result, { status: result.duplicate ? 200 : 201 });
}, { fallbackMessage: "사진을 업로드하지 못했습니다. 잠시 후 다시 시도해주세요." });
