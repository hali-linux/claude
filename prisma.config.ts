// Prisma 7 설정 파일. .env 파일은 자동으로 로드되지 않으므로 dotenv를 명시적으로 로드한다.
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // `prisma generate`는 DB 연결이 필요 없으므로 값이 없어도 동작하도록 기본값을 둔다.
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder",
  },
});
