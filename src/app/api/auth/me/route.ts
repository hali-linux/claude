import { api, json } from "@/lib/http";
import { requireUser } from "@/lib/session";

export const GET = api(async (req) => {
  const user = await requireUser(req);
  return json({ user });
});
