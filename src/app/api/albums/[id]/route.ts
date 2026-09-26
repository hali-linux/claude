import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { albumUpdateSchema } from "@/lib/validation";
import { deleteAlbum, getAlbum, updateAlbum } from "@/services/album-service";
import { getAlbumZipInfo } from "@/services/zip-service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const { album } = await getAlbum(user, id);
  const zip = await getAlbumZipInfo(user, id);
  return json({ album, zip: { parts: zip.parts, perPart: zip.perPart } });
});

export const PUT = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const data = await parseJson(req, albumUpdateSchema);
  const album = await updateAlbum(user, id, data);
  return json({ album: { id: album.id, name: album.name, description: album.description, coverPhotoId: album.coverPhotoId } });
});

export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await deleteAlbum(user, id, { deletePhotos: req.nextUrl.searchParams.get("deletePhotos") === "1" });
  return json({ ok: true });
});
