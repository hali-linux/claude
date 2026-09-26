import { NextResponse } from "next/server";
import { z } from "zod";
import { api, parseJson } from "@/lib/http";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { FAMILY_COOKIE, isSecureCookie, requireUser } from "@/lib/session";
import { acceptInvitation } from "@/services/invitation-service";

export const POST = api(async (req) => {
  const user = await requireUser(req);
  rateLimit(`invite-accept:${user.id}`, RULES.inviteAccept);
  const { token } = await parseJson(req, z.object({ token: z.string().min(10).max(128) }));
  const family = await acceptInvitation(user, token);
  const res = NextResponse.json({ family });
  res.cookies.set(FAMILY_COOKIE, family.id, { httpOnly: true, secure: isSecureCookie(), sameSite: "lax", path: "/", maxAge: 31536000 });
  return res;
});
