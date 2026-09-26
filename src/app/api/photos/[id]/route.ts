import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { photoUpdateSchema } from "@/lib/validation";
import { getPhoto, permanentlyDeletePhoto, softDeletePhoto, updatePhoto } from "@/services/photo-service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  return json({ photo: await getPhoto(user, id) });
});

export const PATCH = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const data = await parseJson(req, photoUpdateSchema);
  return json({ photo: await updatePhoto(user, id, data) });
});

/** 기본: 휴지통으로 이동(Soft Delete). ?permanent=1: 휴지통에서 영구 삭제(가족 관리자) */
export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  if (req.nextUrl.searchParams.get("permanent") === "1") await permanentlyDeletePhoto(user, id);
  else await softDeletePhoto(user, id);
  return json({ ok: true });
});
