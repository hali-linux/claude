import { prisma } from "@/lib/db";
import { api, json, parseJson } from "@/lib/http";
import { requireUser } from "@/lib/session";
import { updateProfileSchema } from "@/lib/validation";

export const PATCH = api(async (req) => {
  const user = await requireUser(req);
  const { name } = await parseJson(req, updateProfileSchema);
  await prisma.user.update({ where: { id: user.id }, data: { name } });
  return json({ ok: true });
});
