import { NextResponse } from "next/server";
import { api } from "@/lib/http";
import { clearSessionCookie, readSessionToken, revokeSessionToken } from "@/lib/session";

export const POST = api(async (req) => {
  await revokeSessionToken(readSessionToken(req));
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
});
