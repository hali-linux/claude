import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { familySchema } from "@/lib/validation";
import { createFamily, listMyFamilies } from "@/services/family-service";

export const GET = api(async (req) => {
  const user = await requireUser(req);
  return json({ families: await listMyFamilies(user) });
});

export const POST = api(async (req) => {
  const user = await requireUser(req);
  const data = await parseJson(req, familySchema);
  const family = await createFamily(user, data);
  return json({ family: { id: family.id, name: family.name } }, { status: 201 });
});
