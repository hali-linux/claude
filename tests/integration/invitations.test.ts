import { beforeEach, describe, expect, it } from "vitest";
import { POST as createInvite, GET as listInvites } from "@/app/api/invitations/route";
import { POST as accept } from "@/app/api/invitations/accept/route";
import { DELETE as revoke } from "@/app/api/invitations/[id]/route";
import { POST as register } from "@/app/api/auth/register/route";
import { prisma } from "@/lib/db";
import { createFamilyWithMembers, createUser, ctx, makeReq, resetDb } from "../helpers";

async function invite(cookie: string, familyId: string, email: string) {
  const res = await createInvite(makeReq("POST", "/api/invitations", { cookie, json: { familyId, email } }), undefined);
  expect(res.status).toBe(201);
  const body = await res.json();
  return { ...body, token: body.url.split("/invite/")[1] as string };
}

describe("초대", () => {
  beforeEach(resetDb);

  it("초대 링크로 가입하면 가족에 참여하고, 링크는 한 번만 사용할 수 있다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const inv = await invite(admin.cookie, family.id, "grandma@example.com");
    expect(inv.url).toMatch(/^http:\/\/localhost:3000\/invite\/[A-Za-z0-9_-]{40,}$/);
    // DB에는 토큰 원문이 저장되지 않는다
    const row = await prisma.invitation.findFirstOrThrow({ where: { email: "grandma@example.com" } });
    expect(row.tokenHash).not.toBe(inv.token);

    const res = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "할머니", email: "grandma@example.com", password: "password123", inviteToken: inv.token } }),
      undefined,
    );
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "grandma@example.com" } });
    expect(await prisma.familyMember.count({ where: { familyId: family.id, userId: user.id } })).toBe(1);

    // 재사용 불가
    const again = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "누군가", email: "grandma2@example.com", password: "password123", inviteToken: inv.token } }),
      undefined,
    );
    expect(again.status).toBe(400);
  });

  it("초대받은 이메일이 아니면 수락할 수 없다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const inv = await invite(admin.cookie, family.id, "uncle@example.com");
    const stranger = await createUser({ email: "stranger@example.com" });
    const res = await accept(makeReq("POST", "/api/invitations/accept", { cookie: stranger.cookie, json: { token: inv.token } }), undefined);
    expect(res.status).toBe(403);
    const reg = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "x", email: "other@example.com", password: "password123", inviteToken: inv.token } }),
      undefined,
    );
    expect(reg.status).toBe(403);
  });

  it("기존 사용자는 로그인 후 초대를 수락할 수 있다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const cousin = await createUser({ email: "cousin@example.com" });
    const inv = await invite(admin.cookie, family.id, "cousin@example.com");
    const res = await accept(makeReq("POST", "/api/invitations/accept", { cookie: cousin.cookie, json: { token: inv.token } }), undefined);
    expect(res.status).toBe(200);
    expect(await prisma.familyMember.count({ where: { familyId: family.id, userId: cousin.user.id } })).toBe(1);
  });

  it("만료되거나 취소된 초대는 사용할 수 없다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const u1 = await createUser({ email: "late@example.com" });
    const inv = await invite(admin.cookie, family.id, "late@example.com");
    await prisma.invitation.updateMany({ where: { email: "late@example.com" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await accept(makeReq("POST", "/api/invitations/accept", { cookie: u1.cookie, json: { token: inv.token } }), undefined)).status).toBe(400);

    const u2 = await createUser({ email: "revoked@example.com" });
    const inv2 = await invite(admin.cookie, family.id, "revoked@example.com");
    const list = await (await listInvites(makeReq("GET", `/api/invitations?familyId=${family.id}`, { cookie: admin.cookie }), undefined)).json();
    const target = list.invitations.find((i: { email: string }) => i.email === "revoked@example.com");
    expect((await revoke(makeReq("DELETE", `/api/invitations/${target.id}`, { cookie: admin.cookie }), ctx({ id: target.id }))).status).toBe(200);
    expect((await accept(makeReq("POST", "/api/invitations/accept", { cookie: u2.cookie, json: { token: inv2.token } }), undefined)).status).toBe(400);
  });

  it("이미 구성원인 이메일은 초대할 수 없다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const res = await createInvite(makeReq("POST", "/api/invitations", { cookie: admin.cookie, json: { familyId: family.id, email: member.user.email } }), undefined);
    expect(res.status).toBe(409);
  });
});
