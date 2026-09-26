import { api, json, parseJson } from "@/lib/http";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { readSessionToken, requireUser } from "@/lib/session";
import { changePasswordSchema } from "@/lib/validation";
import { changePassword } from "@/services/auth-service";

export const PUT = api(async (req) => {
  const user = await requireUser(req);
  rateLimit(`pwchange:${user.id}`, RULES.passwordChange);
  const { currentPassword, newPassword } = await parseJson(req, changePasswordSchema);
  await changePassword(user.id, currentPassword, newPassword, readSessionToken(req));
  return json({ ok: true });
});
