import { api, json, parseQuery } from "@/lib/http";
import { familyIdFor } from "@/lib/family-context";
import { requireUser } from "@/lib/session";
import { photoQuerySchema } from "@/lib/validation";
import { listPhotos } from "@/services/photo-service";

/** 사진 목록/검색 (커서 기반 무한 스크롤) */
export const GET = api(async (req) => {
  const user = await requireUser(req);
  const q = parseQuery(req, photoQuerySchema);
  const familyId = await familyIdFor(req, user, q.familyId);
  return json(await listPhotos(user, familyId, q));
});
