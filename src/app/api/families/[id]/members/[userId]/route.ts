import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { memberUpdateSchema } from "@/lib/validation";
import { removeMember, updateMemberRole } from "@/services/family-service";

type Ctx = { params: Promise<{ id: string; userId: string }> };

export const PATCH = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id, userId } = await params;
  const { role } = await parseJson(req, memberUpdateSchema);
  await updateMemberRole(user, id, userId, role);
  return json({ ok: true });
});

export const DELETE = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id, userId } = await params;
  await removeMember(user, id, userId);
  return json({ ok: true });
});
