import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { listMembers } from "@/services/family-service";

type Ctx = { params: Promise<{ id: string }> };

export const GET = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  return json({ members: await listMembers(user, id) });
});
