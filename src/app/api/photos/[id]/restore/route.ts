import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { restorePhoto } from "@/services/photo-service";

type Ctx = { params: Promise<{ id: string }> };

export const POST = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await restorePhoto(user, id);
  return json({ ok: true });
});
