import { beforeEach, describe, expect, it } from "vitest";
import { POST as upload } from "@/app/api/photos/upload/route";
import { GET as listPhotos } from "@/app/api/photos/route";
import { GET as getPhoto, PATCH as patchPhoto, DELETE as deletePhoto } from "@/app/api/photos/[id]/route";
import { GET as image } from "@/app/api/photos/[id]/image/route";
import { POST as fav } from "@/app/api/photos/[id]/favorite/route";
import { GET as stats } from "@/app/api/families/[id]/stats/route";
import { GET as members } from "@/app/api/families/[id]/members/route";
import { PATCH as patchMember, DELETE as removeMember } from "@/app/api/families/[id]/members/[userId]/route";
import { GET as getAlbum } from "@/app/api/albums/[id]/route";
import { GET as albumZip } from "@/app/api/albums/[id]/download/route";
import { POST as createInvite } from "@/app/api/invitations/route";
import { POST as switchFamily } from "@/app/api/families/current/route";
import { prisma } from "@/lib/db";
import { createFamilyWithMembers, createUser, ctx, makeJpeg, makeReq, photoForm, resetDb } from "../helpers";

async function uploadAs(cookie: string, familyId: string) {
  const res = await upload(makeReq("POST", "/api/photos/upload", { cookie, form: photoForm(await makeJpeg(), "p.jpg", "image/jpeg", { familyId }) }), undefined);
  return (await res.json()).photo as { id: string };
}

describe("권한 / IDOR 방지", () => {
  beforeEach(resetDb);

  it("다른 가족의 사진은 조회/이미지/수정/삭제/즐겨찾기 모두 404", async () => {
    const mine = await createFamilyWithMembers();
    const other = await createFamilyWithMembers();
    const photo = await uploadAs(other.admin.cookie, other.family.id);
    const c = mine.admin.cookie; // 우리 가족 관리자라도 다른 가족 사진에는 접근 불가
    const id = { id: photo.id };

    expect((await getPhoto(makeReq("GET", `/api/photos/${photo.id}`, { cookie: c }), ctx(id))).status).toBe(404);
    for (const v of ["thumb", "large", "original"]) {
      expect((await image(makeReq("GET", `/api/photos/${photo.id}/image?v=${v}`, { cookie: c }), ctx(id))).status).toBe(404);
    }
    expect((await patchPhoto(makeReq("PATCH", `/api/photos/${photo.id}`, { cookie: c, json: { description: "해킹" } }), ctx(id))).status).toBe(404);
    expect((await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}`, { cookie: c }), ctx(id))).status).toBe(404);
    expect((await fav(makeReq("POST", `/api/photos/${photo.id}/favorite`, { cookie: c }), ctx(id))).status).toBe(404);

    // familyId 파라미터를 조작해 다른 가족 목록을 요청해도 차단
    expect((await listPhotos(makeReq("GET", `/api/photos?familyId=${other.family.id}`, { cookie: c }), undefined)).status).toBe(404);
    // 다른 가족에 업로드 시도도 차단
    const up = await upload(
      makeReq("POST", "/api/photos/upload", { cookie: c, form: photoForm(await makeJpeg(), "p.jpg", "image/jpeg", { familyId: other.family.id }) }),
      undefined,
    );
    expect(up.status).toBe(404);
    // 현재 가족 쿠키를 다른 가족으로 전환하는 것도 차단
    expect((await switchFamily(makeReq("POST", "/api/families/current", { cookie: c, json: { familyId: other.family.id } }), undefined)).status).toBe(404);

    const row = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(row.description).toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  it("다른 가족의 앨범/ZIP/구성원 목록에 접근할 수 없다", async () => {
    const mine = await createFamilyWithMembers();
    const other = await createFamilyWithMembers();
    const album = await prisma.album.create({ data: { familyId: other.family.id, name: "비밀 앨범" } });
    expect((await getAlbum(makeReq("GET", `/api/albums/${album.id}`, { cookie: mine.admin.cookie }), ctx({ id: album.id }))).status).toBe(404);
    expect((await albumZip(makeReq("GET", `/api/albums/${album.id}/download`, { cookie: mine.admin.cookie }), ctx({ id: album.id }))).status).toBe(404);
    expect((await members(makeReq("GET", `/api/families/${other.family.id}/members`, { cookie: mine.member.cookie }), ctx({ id: other.family.id }))).status).toBe(404);
  });

  it("일반 구성원(MEMBER)은 관리자 기능에 접근할 수 없다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const fid = { id: family.id };
    expect((await stats(makeReq("GET", `/api/families/${family.id}/stats`, { cookie: member.cookie }), ctx(fid))).status).toBe(403);
    expect((await stats(makeReq("GET", `/api/families/${family.id}/stats`, { cookie: admin.cookie }), ctx(fid))).status).toBe(200);
    expect(
      (await createInvite(makeReq("POST", "/api/invitations", { cookie: member.cookie, json: { familyId: family.id, email: "new@example.com" } }), undefined)).status,
    ).toBe(403);
    // 스스로를 관리자로 승격할 수 없다
    expect(
      (await patchMember(
        makeReq("PATCH", `/api/families/${family.id}/members/${member.user.id}`, { cookie: member.cookie, json: { role: "ADMIN" } }),
        ctx({ id: family.id, userId: member.user.id }),
      )).status,
    ).toBe(403);
    // 다른 구성원을 제거할 수 없다
    expect(
      (await removeMember(
        makeReq("DELETE", `/api/families/${family.id}/members/${admin.user.id}`, { cookie: member.cookie }),
        ctx({ id: family.id, userId: admin.user.id }),
      )).status,
    ).toBe(403);
  });

  it("MEMBER는 다른 사용자의 사진을 삭제/수정할 수 없고, ADMIN은 모든 사진을 삭제할 수 있다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const sister = await createUser({ name: "언니" });
    await prisma.familyMember.create({ data: { familyId: family.id, userId: sister.user.id } });
    const photo = await uploadAs(sister.cookie, family.id);
    const id = { id: photo.id };

    expect((await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}`, { cookie: member.cookie }), ctx(id))).status).toBe(403);
    expect((await patchPhoto(makeReq("PATCH", `/api/photos/${photo.id}`, { cookie: member.cookie, json: { description: "x" } }), ctx(id))).status).toBe(403);
    // 조회는 가능
    const got = await (await getPhoto(makeReq("GET", `/api/photos/${photo.id}`, { cookie: member.cookie }), ctx(id))).json();
    expect(got.photo.canModify).toBe(false);

    expect((await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}`, { cookie: admin.cookie }), ctx(id))).status).toBe(200);
  });

  it("마지막 관리자는 강등/제거할 수 없다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const demote = await patchMember(
      makeReq("PATCH", `/api/families/${family.id}/members/${admin.user.id}`, { cookie: admin.cookie, json: { role: "MEMBER" } }),
      ctx({ id: family.id, userId: admin.user.id }),
    );
    expect(demote.status).toBe(400);
    // 관리자는 구성원을 제거할 수 있다
    const rm = await removeMember(
      makeReq("DELETE", `/api/families/${family.id}/members/${member.user.id}`, { cookie: admin.cookie }),
      ctx({ id: family.id, userId: member.user.id }),
    );
    expect(rm.status).toBe(200);
    // 제거된 구성원은 더 이상 가족 사진을 볼 수 없다
    expect((await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}`, { cookie: member.cookie }), undefined)).status).toBe(404);
  });
});
