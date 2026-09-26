import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";
import pg from "pg";
import { TEST_DATABASE_URL, TEST_STORAGE_DIR } from "./test-env";

/** 테스트 시작 전: 테스트 DB 스키마를 초기화하고 마이그레이션을 적용한다. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
  await rm(TEST_STORAGE_DIR, { recursive: true, force: true });
}
