import { z } from "zod";
import { api, json, parseJson, parseQuery } from "@/lib/http";
import { familyIdFor } from "@/lib/family-context";
import { rateLimit, RULES } from "@/lib/rate-limit";
import { requireUser } from "@/lib/session";
import { idSchema, invitationCreateSchema } from "@/lib/validation";
import { createInvitation, listInvitations } from "@/services/invitation-service";

export const GET = api(async (req) => {
  const user = await requireUser(req);
  const q = parseQuery(req, z.object({ familyId: idSchema.optional() }));
  const familyId = await familyIdFor(req, user, q.familyId);
  return json({ invitations: await listInvitations(user, familyId) });
});

export const POST = api(async (req) => {
  const user = await requireUser(req);
  rateLimit(`invite:${user.id}`, RULES.invite);
  const data = await parseJson(req, invitationCreateSchema);
  const { invitation, url, emailSent } = await createInvitation(user, data);
  // 초대 URL은 생성 직후 관리자에게 한 번만 보여준다(DB에는 해시만 저장되어 다시 조회 불가).
  return json(
    { invitation: { id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt }, url, emailSent },
    { status: 201 },
  );
});
