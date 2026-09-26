import { z } from "zod";
import { api, json, parseJson, parseQuery } from "@/lib/http";
import { familyIdFor } from "@/lib/family-context";
import { requireUser } from "@/lib/session";
import { albumCreateSchema, idSchema } from "@/lib/validation";
import { createAlbum, listAlbums } from "@/services/album-service";

export const GET = api(async (req) => {
  const user = await requireUser(req);
  const q = parseQuery(req, z.object({ familyId: idSchema.optional() }));
  const familyId = await familyIdFor(req, user, q.familyId);
  return json({ albums: await listAlbums(user, familyId) });
});

export const POST = api(async (req) => {
  const user = await requireUser(req);
  const data = await parseJson(req, albumCreateSchema);
  const album = await createAlbum(user, data);
  return json({ album: { id: album.id, name: album.name } }, { status: 201 });
});
