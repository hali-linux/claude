import { NextRequest } from "next/server";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createSession, sessionCookieName } from "@/lib/session";
import { clearAllRateLimits } from "@/lib/rate-limit";

export const BASE = "http://localhost:3000";

export async function resetDb() {
  clearAllRateLimits();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Activity","Favorite","Invitation","Photo","Album","FamilyMember","Family","Session","User" CASCADE',
  );
}

interface ReqOpts {
  cookie?: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** false면 Origin 헤더를 보내지 않는다(CSRF 테스트용) */
  origin?: string | false;
}

export function makeReq(method: string, path: string, opts: ReqOpts = {}) {
  const headers = new Headers(opts.headers);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.origin !== false && method !== "GET") headers.set("origin", opts.origin ?? BASE);
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  const init = { method, headers, body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1];
  return new NextRequest(new URL(path, BASE), init);
}

export const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

let seq = 0;
export async function createUser(opts: { name?: string; email?: string; password?: string } = {}) {
  seq++;
  const user = await prisma.user.create({
    data: {
      name: opts.name ?? `사용자${seq}`,
      email: opts.email ?? `user${seq}-${Date.now()}@example.com`,
      passwordHash: await hashPassword(opts.password ?? "password123"),
    },
  });
  const { token } = await createSession(user.id);
  return { user, cookie: `${sessionCookieName()}=${token}` };
}

/** 가족 + 관리자 + 일반 구성원을 만든다 */
export async function createFamilyWithMembers() {
  const admin = await createUser({ name: "아빠" });
  const member = await createUser({ name: "딸" });
  const family = await prisma.family.create({
    data: {
      name: "우리 가족",
      members: {
        create: [
          { userId: admin.user.id, role: "ADMIN" },
          { userId: member.user.id, role: "MEMBER" },
        ],
      },
    },
  });
  return { family, admin, member };
}

let colorSeq = 0;
/** 테스트용 JPEG 생성 (매번 다른 색 → 다른 해시) */
export async function makeJpeg(width = 800, height = 600) {
  colorSeq++;
  return sharp({
    create: { width, height, channels: 3, background: { r: (colorSeq * 37) % 256, g: (colorSeq * 91) % 256, b: (colorSeq * 13) % 256 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

export function photoForm(buf: Buffer | Uint8Array, name: string, type: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buf)], name, { type }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return form;
}
