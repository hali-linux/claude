import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMembership } from "@/lib/access";
import { api, parseJson } from "@/lib/http";
import { FAMILY_COOKIE, isSecureCookie, requireUser } from "@/lib/session";
import { idSchema } from "@/lib/validation";

/** 현재 보고 있는 가족 그룹 전환 */
export const POST = api(async (req) => {
  const user = await requireUser(req);
  const { familyId } = await parseJson(req, z.object({ familyId: idSchema }));
  await requireMembership(user, familyId);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(FAMILY_COOKIE, familyId, {
    httpOnly: true,
    secure: isSecureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
});
