/**
 * 개발용 시드 데이터: 관리자/구성원 계정과 샘플 앨범을 만든다.
 *   npm run db:seed
 * 계정: dad@example.com / password123 (가족 관리자), mom@example.com / password123 (구성원)
 * ⚠️ 운영 DB에서는 실행하지 마세요.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("운영환경에서는 시드를 실행할 수 없습니다.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

async function main() {
  if ((await prisma.user.count()) > 0) {
    console.log("이미 사용자가 있어 시드를 건너뜁니다.");
    return;
  }
  const passwordHash = await bcrypt.hash("password123", 12);
  const dad = await prisma.user.create({ data: { name: "아빠", email: "dad@example.com", passwordHash, role: "ADMIN" } });
  const mom = await prisma.user.create({ data: { name: "엄마", email: "mom@example.com", passwordHash } });
  const family = await prisma.family.create({
    data: {
      name: "우리 가족",
      description: "우리 가족의 소중한 추억",
      members: { create: [{ userId: dad.id, role: "ADMIN" }, { userId: mom.id, role: "MEMBER" }] },
    },
  });
  for (const name of ["2026년 가족여행", "부모님 결혼기념일", "아이들 성장사진", "명절"]) {
    await prisma.album.create({ data: { familyId: family.id, name, createdById: dad.id } });
  }
  console.log("시드 완료: dad@example.com / mom@example.com (비밀번호 password123)");
}

main().finally(() => prisma.$disconnect());
