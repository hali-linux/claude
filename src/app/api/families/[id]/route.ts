import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { familySchema } from "@/lib/validation";
import { updateFamily } from "@/services/family-service";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = api<Ctx>(async (req, { params }) => {
  const user = await requireUser(req);
  const { id } = await params;
  const data = await parseJson(req, familySchema);
  const family = await updateFamily(user, id, data);
  return json({ family: { id: family.id, name: family.name, description: family.description } });
});
