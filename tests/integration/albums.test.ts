import { beforeEach, describe, expect, it } from "vitest";
import { POST as createAlbum, GET as listAlbums } from "@/app/api/albums/route";
import { GET as getAlbum, PUT as updateAlbum, DELETE as deleteAlbum } from "@/app/api/albums/[id]/route";
import { GET as albumZip } from "@/app/api/albums/[id]/download/route";
import { POST as upload } from "@/app/api/photos/upload/route";
import { PATCH as patchPhoto } from "@/app/api/photos/[id]/route";
import { GET as listPhotos } from "@/app/api/photos/route";
import { prisma } from "@/lib/db";
import { createFamilyWithMembers, ctx, makeJpeg, makeReq, photoForm, resetDb } from "../helpers";

async function uploadTo(cookie: string, familyId: string, albumId?: string, name = "p.jpg") {
  const res = await upload(
    makeReq("POST", "/api/photos/upload", { cookie, form: photoForm(await makeJpeg(), name, "image/jpeg", { familyId, ...(albumId ? { albumId } : {}) }) }),
    undefined,
  );
  return (await res.json()).photo as { id: string };
}

describe("앨범", () => {
  beforeEach(resetDb);

  it("관리자는 앨범을 생성/수정/삭제할 수 있고, MEMBER는 생성할 수 없다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const denied = await createAlbum(makeReq("POST", "/api/albums", { cookie: member.cookie, json: { familyId: family.id, name: "x" } }), undefined);
    expect(denied.status).toBe(403);

    const res = await createAlbum(
      makeReq("POST", "/api/albums", { cookie: admin.cookie, json: { familyId: family.id, name: "2026 가족여행", description: "제주도" } }),
      undefined,
    );
    expect(res.status).toBe(201);
    const { album } = await res.json();

    const upd = await updateAlbum(
      makeReq("PUT", `/api/albums/${album.id}`, { cookie: admin.cookie, json: { name: "2026 제주 가족여행" } }),
      ctx({ id: album.id }),
    );
    expect(upd.status).toBe(200);
    expect((await upd.json()).album.name).toBe("2026 제주 가족여행");

    const list = await (await listAlbums(makeReq("GET", `/api/albums?familyId=${family.id}`, { cookie: member.cookie }), undefined)).json();
    expect(list.albums).toHaveLength(1);

    expect((await deleteAlbum(makeReq("DELETE", `/api/albums/${album.id}`, { cookie: member.cookie }), ctx({ id: album.id }))).status).toBe(403);
    expect((await deleteAlbum(makeReq("DELETE", `/api/albums/${album.id}`, { cookie: admin.cookie }), ctx({ id: album.id }))).status).toBe(200);
    expect(await prisma.album.count()).toBe(0);
  });

  it("앨범에 사진 추가/이동, 앨범별 조회, 대표사진 지정", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const album = await prisma.album.create({ data: { familyId: family.id, name: "명절" } });
    const inAlbum = await uploadTo(member.cookie, family.id, album.id);
    const loose = await uploadTo(member.cookie, family.id);

    // 업로드 후 앨범으로 이동
    const moved = await patchPhoto(
      makeReq("PATCH", `/api/photos/${loose.id}`, { cookie: member.cookie, json: { albumId: album.id } }),
      ctx({ id: loose.id }),
    );
    expect(moved.status).toBe(200);

    const items = (await (await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}&albumId=${album.id}`, { cookie: member.cookie }), undefined)).json()).items;
    expect(items).toHaveLength(2);

    const cover = await updateAlbum(
      makeReq("PUT", `/api/albums/${album.id}`, { cookie: admin.cookie, json: { coverPhotoId: inAlbum.id } }),
      ctx({ id: album.id }),
    );
    expect(cover.status).toBe(200);
    const detail = await (await getAlbum(makeReq("GET", `/api/albums/${album.id}`, { cookie: member.cookie }), ctx({ id: album.id }))).json();
    expect(detail.album.photoCount).toBe(2);
    expect(detail.album.coverUrl).toContain(inAlbum.id);
  });

  it("다른 가족 앨범으로 사진을 이동할 수 없다", async () => {
    const a = await createFamilyWithMembers();
    const b = await createFamilyWithMembers();
    const foreign = await prisma.album.create({ data: { familyId: b.family.id, name: "남의 앨범" } });
    const photo = await uploadTo(a.admin.cookie, a.family.id);
    const res = await patchPhoto(
      makeReq("PATCH", `/api/photos/${photo.id}`, { cookie: a.admin.cookie, json: { albumId: foreign.id } }),
      ctx({ id: photo.id }),
    );
    expect(res.status).toBe(404);
  });

  it("앨범 삭제 시 옵션에 따라 사진을 미분류로 남기거나 휴지통으로 보낸다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const keep = await prisma.album.create({ data: { familyId: family.id, name: "A" } });
    const drop = await prisma.album.create({ data: { familyId: family.id, name: "B" } });
    const p1 = await uploadTo(admin.cookie, family.id, keep.id);
    const p2 = await uploadTo(admin.cookie, family.id, drop.id);
    await deleteAlbum(makeReq("DELETE", `/api/albums/${keep.id}`, { cookie: admin.cookie }), ctx({ id: keep.id }));
    await deleteAlbum(makeReq("DELETE", `/api/albums/${drop.id}?deletePhotos=1`, { cookie: admin.cookie }), ctx({ id: drop.id }));
    const r1 = await prisma.photo.findUniqueOrThrow({ where: { id: p1.id } });
    const r2 = await prisma.photo.findUniqueOrThrow({ where: { id: p2.id } });
    expect(r1.albumId).toBeNull();
    expect(r1.deletedAt).toBeNull();
    expect(r2.deletedAt).not.toBeNull();
  });

  it("앨범 ZIP 다운로드(스트리밍, 분할)", async () => {
    const { family, member } = await createFamilyWithMembers();
    const album = await prisma.album.create({ data: { familyId: family.id, name: "여행" } });
    for (let i = 0; i < 12; i++) await uploadTo(member.cookie, family.id, album.id, i === 1 ? "same.jpg" : i === 2 ? "same.jpg" : `p${i}.jpg`);

    const info = await (await getAlbum(makeReq("GET", `/api/albums/${album.id}`, { cookie: member.cookie }), ctx({ id: album.id }))).json();
    expect(info.zip.parts).toBe(2); // 테스트 환경 MAX_ZIP_PHOTOS=10

    const res = await albumZip(makeReq("GET", `/api/albums/${album.id}/download?part=1`, { cookie: member.cookie }), ctx({ id: album.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    // ZIP 중앙 디렉터리의 파일 엔트리 수
    const entries = buf.toString("latin1").split("PK\u0001\u0002").length - 1;
    expect(entries).toBe(10);
    expect(buf.toString("latin1")).toContain("same (1).jpg");

    const part2 = await albumZip(makeReq("GET", `/api/albums/${album.id}/download?part=2`, { cookie: member.cookie }), ctx({ id: album.id }));
    const buf2 = Buffer.from(await part2.arrayBuffer());
    expect(buf2.toString("latin1").split("PK\u0001\u0002").length - 1).toBe(2);
  });
});
