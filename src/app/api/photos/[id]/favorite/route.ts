import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { setFavorite } from "@/services/photo-service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await setFavorite(user, id, true);
  return json({ favorite: true });
});

export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await setFavorite(user, id, false);
  return json({ favorite: false });
});
