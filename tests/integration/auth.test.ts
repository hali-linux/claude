import { beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { PUT as changePassword } from "@/app/api/auth/password/route";
import { GET as listPhotos } from "@/app/api/photos/route";
import { GET as image } from "@/app/api/photos/[id]/image/route";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { sessionCookieName } from "@/lib/session";
import { createUser, ctx, makeReq, resetDb } from "../helpers";

function cookieFrom(res: Response) {
  const set = res.headers.get("set-cookie") ?? "";
  const m = set.match(new RegExp(`${sessionCookieName()}=([^;]*)`));
  return m ? `${sessionCookieName()}=${m[1]}` : "";
}

describe("인증", () => {
  beforeEach(resetDb);

  it("최초 사용자는 초대 없이 가입할 수 있고 가족 관리자가 된다", async () => {
    const res = await register(
      makeReq("POST", "/api/auth/register", {
        json: { name: "아빠", email: "Dad@Example.com", password: "password123", familyName: "우리 가족" },
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "dad@example.com" } });
    expect(user.role).toBe("ADMIN");
    // 비밀번호는 평문이 아닌 bcrypt 해시로 저장된다
    expect(user.passwordHash).not.toContain("password123");
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(await verifyPassword("password123", user.passwordHash)).toBe(true);

    const m = await prisma.familyMember.findFirstOrThrow({ where: { userId: user.id }, include: { family: true } });
    expect(m.role).toBe("ADMIN");
    expect(m.family.name).toBe("우리 가족");
  });

  it("두 번째 사용자부터는 초대 없이 가입할 수 없다(기본 설정)", async () => {
    await createUser();
    const res = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "낯선사람", email: "x@example.com", password: "password123" } }),
      undefined,
    );
    expect(res.status).toBe(403);
  });

  it("약한 비밀번호/잘못된 이메일은 거부한다", async () => {
    const weak = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "a", email: "a@example.com", password: "short" } }),
      undefined,
    );
    expect(weak.status).toBe(400);
    const badEmail = await register(
      makeReq("POST", "/api/auth/register", { json: { name: "a", email: "not-email", password: "password123" } }),
      undefined,
    );
    expect(badEmail.status).toBe(400);
    expect((await badEmail.json()).error).toContain("이메일");
  });

  it("로그인 → 내 정보 조회 → 로그아웃 후 세션이 무효화된다", async () => {
    await createUser({ email: "mom@example.com", password: "password123" });
    const res = await login(makeReq("POST", "/api/auth/login", { json: { email: "mom@example.com", password: "password123" } }), undefined);
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).not.toBe("");

    const meRes = await me(makeReq("GET", "/api/auth/me", { cookie }), undefined);
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).user.email).toBe("mom@example.com");

    const out = await logout(makeReq("POST", "/api/auth/logout", { cookie }), undefined);
    expect(out.status).toBe(200);

    const after = await me(makeReq("GET", "/api/auth/me", { cookie }), undefined);
    expect(after.status).toBe(401);
  });

  it("잘못된 비밀번호는 거부하고, 존재하지 않는 계정과 같은 메시지를 반환한다", async () => {
    await createUser({ email: "son@example.com", password: "password123" });
    const wrong = await login(makeReq("POST", "/api/auth/login", { json: { email: "son@example.com", password: "wrongpass1" } }), undefined);
    const none = await login(makeReq("POST", "/api/auth/login", { json: { email: "nobody@example.com", password: "wrongpass1" } }), undefined);
    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect((await wrong.json()).error).toBe((await none.json()).error);
  });

  it("로그인 시도 횟수를 제한한다(Rate Limiting)", async () => {
    await createUser({ email: "rl@example.com", password: "password123" });
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await login(makeReq("POST", "/api/auth/login", { json: { email: "rl@example.com", password: "wrongpass1" } }), undefined);
    }
    expect(last!.status).toBe(429);
  });

  it("인증되지 않은 사용자는 사진 목록/이미지에 접근할 수 없다", async () => {
    const list = await listPhotos(makeReq("GET", "/api/photos"), undefined);
    expect(list.status).toBe(401);
    const img = await image(makeReq("GET", "/api/photos/abc/image?v=original"), ctx({ id: "abc" }));
    expect(img.status).toBe(401);
    const forged = await listPhotos(makeReq("GET", "/api/photos", { cookie: `${sessionCookieName()}=forged-token` }), undefined);
    expect(forged.status).toBe(401);
  });

  it("Origin 헤더가 없거나 다른 사이트면 상태 변경 요청을 거부한다(CSRF)", async () => {
    await createUser({ email: "csrf@example.com", password: "password123" });
    const noOrigin = await login(
      makeReq("POST", "/api/auth/login", { json: { email: "csrf@example.com", password: "password123" }, origin: false }),
      undefined,
    );
    expect(noOrigin.status).toBe(403);
    const evil = await login(
      makeReq("POST", "/api/auth/login", { json: { email: "csrf@example.com", password: "password123" }, origin: "https://evil.example" }),
      undefined,
    );
    expect(evil.status).toBe(403);
  });

  it("비밀번호 변경 시 현재 비밀번호를 확인하고 다른 세션을 로그아웃시킨다", async () => {
    const { user, cookie } = await createUser({ password: "password123" });
    const other = await login(makeReq("POST", "/api/auth/login", { json: { email: user.email, password: "password123" } }), undefined);
    const otherCookie = cookieFrom(other);

    const wrong = await changePassword(
      makeReq("PUT", "/api/auth/password", { cookie, json: { currentPassword: "nope12345", newPassword: "newpass123" } }),
      undefined,
    );
    expect(wrong.status).toBe(400);

    const ok = await changePassword(
      makeReq("PUT", "/api/auth/password", { cookie, json: { currentPassword: "password123", newPassword: "newpass123" } }),
      undefined,
    );
    expect(ok.status).toBe(200);
    expect((await me(makeReq("GET", "/api/auth/me", { cookie }), undefined)).status).toBe(200);
    expect((await me(makeReq("GET", "/api/auth/me", { cookie: otherCookie }), undefined)).status).toBe(401);

    const relogin = await login(makeReq("POST", "/api/auth/login", { json: { email: user.email, password: "newpass123" } }), undefined);
    expect(relogin.status).toBe(200);
  });
});
