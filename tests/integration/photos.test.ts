import { beforeEach, describe, expect, it } from "vitest";
import { POST as upload } from "@/app/api/photos/upload/route";
import { GET as listPhotos } from "@/app/api/photos/route";
import { GET as getPhoto, PATCH as patchPhoto, DELETE as deletePhoto } from "@/app/api/photos/[id]/route";
import { GET as image } from "@/app/api/photos/[id]/image/route";
import { POST as restore } from "@/app/api/photos/[id]/restore/route";
import { POST as fav, DELETE as unfav } from "@/app/api/photos/[id]/favorite/route";
import { GET as trash } from "@/app/api/families/[id]/trash/route";
import { prisma } from "@/lib/db";
import { getStorage } from "@/services/storage";
import sharp from "sharp";
import { createFamilyWithMembers, ctx, makeJpeg, makeReq, photoForm, resetDb } from "../helpers";

async function uploadAs(cookie: string, familyId: string, buf?: Buffer, name = "photo.jpg", type = "image/jpeg", extra = {}) {
  return upload(makeReq("POST", "/api/photos/upload", { cookie, form: photoForm(buf ?? (await makeJpeg()), name, type, { familyId, ...extra }) }), undefined);
}

describe("사진 업로드", () => {
  beforeEach(resetDb);

  it("정상적인 이미지를 업로드하면 썸네일/대형 이미지가 생성된다", async () => {
    const { family, member } = await createFamilyWithMembers();
    const res = await uploadAs(member.cookie, family.id, await makeJpeg(3000, 2000), "제주도.jpg");
    expect(res.status).toBe(201);
    const { photo } = await res.json();
    expect(photo.originalName).toBe("제주도.jpg");
    expect(photo.width).toBe(3000);
    expect(photo.height).toBe(2000);
    expect(photo.thumbUrl).toBe(`/api/photos/${photo.id}/image?v=thumb`);

    const row = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } });
    const storage = getStorage();
    expect(await storage.exists(row.originalKey)).toBe(true);
    expect(await storage.exists(row.thumbKey)).toBe(true);
    // 저장소 키에 사용자 입력 파일명이 들어가지 않는다(경로 조작 방지)
    expect(row.originalKey).not.toContain("제주도");

    const thumbRes = await image(makeReq("GET", `/api/photos/${photo.id}/image?v=thumb`, { cookie: member.cookie }), ctx({ id: photo.id }));
    expect(thumbRes.status).toBe(200);
    expect(thumbRes.headers.get("content-type")).toBe("image/webp");
    expect(thumbRes.headers.get("cache-control")).toContain("private");
    const meta = await sharp(Buffer.from(await thumbRes.arrayBuffer())).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(640);
  });

  it("여러 장을 동시에 업로드할 수 있다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => uploadAs(admin.cookie, family.id, await makeJpeg(400 + i, 300), `p${i}.jpg`)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const list = await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}`, { cookie: admin.cookie }), undefined);
    expect((await list.json()).items).toHaveLength(5);
    // 연속 업로드는 하나의 활동으로 묶인다
    const act = await prisma.activity.findFirstOrThrow({ where: { familyId: family.id, type: "PHOTO_UPLOAD" } });
    expect(act.count).toBe(5);
  });

  it("같은 사진을 다시 올리면 중복 저장하지 않는다(재시도 멱등성)", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const buf = await makeJpeg();
    const first = await uploadAs(admin.cookie, family.id, buf);
    const second = await uploadAs(admin.cookie, family.id, buf);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
    expect(await prisma.photo.count()).toBe(1);
  });

  it("너무 큰 파일은 거부한다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1.5 * 1024 * 1024, 1)]);
    const res = await uploadAs(admin.cookie, family.id, big, "big.jpg");
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("MB");
  });

  it("허용되지 않은 파일 형식은 거부한다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    // 확장자가 틀린 경우
    expect((await uploadAs(admin.cookie, family.id, html, "x.html", "text/html")).status).toBe(415);
    // 확장자/MIME을 이미지로 위장한 경우 → 매직 바이트 검사에서 차단
    expect((await uploadAs(admin.cookie, family.id, html, "evil.jpg", "image/jpeg")).status).toBe(415);
    // SVG는 스크립트를 포함할 수 있어 허용하지 않는다
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await uploadAs(admin.cookie, family.id, svg, "a.svg", "image/svg+xml")).status).toBe(415);
    // JPEG 시그니처만 흉내 낸 손상 파일
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
    expect((await uploadAs(admin.cookie, family.id, broken, "broken.jpg")).status).toBe(415);
    expect(await prisma.photo.count()).toBe(0);
  });

  it("PNG/WEBP도 업로드할 수 있다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const png = await sharp({ create: { width: 50, height: 40, channels: 4, background: "#f00" } }).png().toBuffer();
    const webp = await sharp({ create: { width: 50, height: 40, channels: 3, background: "#0f0" } }).webp().toBuffer();
    expect((await uploadAs(admin.cookie, family.id, png, "a.png", "image/png")).status).toBe(201);
    expect((await uploadAs(admin.cookie, family.id, webp, "b.webp", "image/webp")).status).toBe(201);
  });

  it("EXIF 촬영일시를 추출하고, 파생 이미지에서는 EXIF(위치정보)를 제거한다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const withExif = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#123456" } })
      .jpeg()
      .withExif({ IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: "2024:05:05 10:30:00" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const res = await uploadAs(admin.cookie, family.id, withExif, "exif.jpg");
    expect(res.status).toBe(201);
    const { photo } = await res.json();
    expect(photo.takenAt).not.toBeNull();
    expect(new Date(photo.takenAt).getFullYear()).toBe(2024);
    // Orientation=6(90도 회전) 반영 → 가로/세로가 바뀐다
    expect(photo.width).toBe(100);
    expect(photo.height).toBe(200);

    const large = await image(makeReq("GET", `/api/photos/${photo.id}/image?v=large`, { cookie: admin.cookie }), ctx({ id: photo.id }));
    const meta = await sharp(Buffer.from(await large.arrayBuffer())).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(100);
  });

  it("앨범이 다른 가족 소속이면 업로드를 거부한다", async () => {
    const a = await createFamilyWithMembers();
    const b = await createFamilyWithMembers();
    const otherAlbum = await prisma.album.create({ data: { familyId: b.family.id, name: "남의 앨범" } });
    const res = await uploadAs(a.admin.cookie, a.family.id, undefined, "x.jpg", "image/jpeg", { albumId: otherAlbum.id });
    expect(res.status).toBe(404);
  });
});

describe("사진 조회/검색/수정/삭제", () => {
  beforeEach(resetDb);

  it("설명 수정, 검색, 즐겨찾기", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const { photo } = await (await uploadAs(member.cookie, family.id, undefined, "beach.jpg")).json();
    await uploadAs(member.cookie, family.id, undefined, "mountain.jpg");

    const patched = await patchPhoto(
      makeReq("PATCH", `/api/photos/${photo.id}`, { cookie: member.cookie, json: { description: "해운대 바다" } }),
      ctx({ id: photo.id }),
    );
    expect(patched.status).toBe(200);

    const search = async (qs: string, cookie = member.cookie) =>
      (await (await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}&${qs}`, { cookie }), undefined)).json()).items;
    expect(await search("q=해운대")).toHaveLength(1);
    expect(await search("q=MOUNTAIN")).toHaveLength(1);
    expect(await search("q=딸")).toHaveLength(2); // 업로드 사용자 이름
    expect(await search("preset=today")).toHaveLength(2);
    expect(await search("preset=custom&from=2000-01-01&to=2000-01-02")).toHaveLength(0);

    expect((await fav(makeReq("POST", `/api/photos/${photo.id}/favorite`, { cookie: admin.cookie }), ctx({ id: photo.id }))).status).toBe(200);
    expect(await search("favorites=1", admin.cookie)).toHaveLength(1);
    expect(await search("favorites=1", member.cookie)).toHaveLength(0); // 즐겨찾기는 사용자별
    await unfav(makeReq("DELETE", `/api/photos/${photo.id}/favorite`, { cookie: admin.cookie }), ctx({ id: photo.id }));
    expect(await search("favorites=1", admin.cookie)).toHaveLength(0);
  });

  it("커서 기반 페이지네이션", async () => {
    const { family, admin } = await createFamilyWithMembers();
    for (let i = 0; i < 5; i++) await uploadAs(admin.cookie, family.id);
    const p1 = await (await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}&limit=3`, { cookie: admin.cookie }), undefined)).json();
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await (
      await listPhotos(makeReq("GET", `/api/photos?familyId=${family.id}&limit=3&cursor=${p1.nextCursor}`, { cookie: admin.cookie }), undefined)
    ).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const ids = new Set([...p1.items, ...p2.items].map((p: { id: string }) => p.id));
    expect(ids.size).toBe(5);
  });

  it("사진 삭제는 휴지통으로 이동(Soft Delete)하고 관리자가 복구할 수 있다", async () => {
    const { family, admin, member } = await createFamilyWithMembers();
    const { photo } = await (await uploadAs(member.cookie, family.id)).json();

    const del = await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}`, { cookie: member.cookie }), ctx({ id: photo.id }));
    expect(del.status).toBe(200);
    expect((await getPhoto(makeReq("GET", `/api/photos/${photo.id}`, { cookie: member.cookie }), ctx({ id: photo.id }))).status).toBe(404);
    const row = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } });
    expect(row.deletedAt).not.toBeNull();

    // 일반 구성원은 휴지통/복구 불가
    expect((await trash(makeReq("GET", `/api/families/${family.id}/trash`, { cookie: member.cookie }), ctx({ id: family.id }))).status).toBe(403);
    expect((await restore(makeReq("POST", `/api/photos/${photo.id}/restore`, { cookie: member.cookie }), ctx({ id: photo.id }))).status).toBe(403);

    const t = await (await trash(makeReq("GET", `/api/families/${family.id}/trash`, { cookie: admin.cookie }), ctx({ id: family.id }))).json();
    expect(t.items).toHaveLength(1);
    expect((await restore(makeReq("POST", `/api/photos/${photo.id}/restore`, { cookie: admin.cookie }), ctx({ id: photo.id }))).status).toBe(200);
    expect((await getPhoto(makeReq("GET", `/api/photos/${photo.id}`, { cookie: member.cookie }), ctx({ id: photo.id }))).status).toBe(200);
  });

  it("영구 삭제 시 저장소 파일도 삭제된다", async () => {
    const { family, admin } = await createFamilyWithMembers();
    const { photo } = await (await uploadAs(admin.cookie, family.id)).json();
    const row = await prisma.photo.findUniqueOrThrow({ where: { id: photo.id } });
    // 휴지통에 없는 사진은 바로 영구 삭제할 수 없다
    expect((await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}?permanent=1`, { cookie: admin.cookie }), ctx({ id: photo.id }))).status).toBe(400);
    await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}`, { cookie: admin.cookie }), ctx({ id: photo.id }));
    expect((await deletePhoto(makeReq("DELETE", `/api/photos/${photo.id}?permanent=1`, { cookie: admin.cookie }), ctx({ id: photo.id }))).status).toBe(200);
    expect(await prisma.photo.count()).toBe(0);
    expect(await getStorage().exists(row.originalKey)).toBe(false);
  });

  it("원본 다운로드는 attachment로 원본 파일을 그대로 제공한다", async () => {
    const { family, member } = await createFamilyWithMembers();
    const buf = await makeJpeg();
    const { photo } = await (await uploadAs(member.cookie, family.id, buf, "가족사진.jpg")).json();
    const res = await image(makeReq("GET", `/api/photos/${photo.id}/image?v=original&download=1`, { cookie: member.cookie }), ctx({ id: photo.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(encodeURIComponent("가족사진.jpg"));
    expect(Buffer.from(await res.arrayBuffer()).equals(buf)).toBe(true);
  });
});
