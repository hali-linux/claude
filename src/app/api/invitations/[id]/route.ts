import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { revokeInvitation } from "@/services/invitation-service";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  await revokeInvitation(user, id);
  return json({ ok: true });
});
