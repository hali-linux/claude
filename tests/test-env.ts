import os from "node:os";
import path from "node:path";

/** 테스트 전용 환경변수. 개발 DB를 건드리지 않도록 별도의 테스트 DB를 사용한다. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://family:family@localhost:5432/family_photos_test?schema=public";

export const TEST_STORAGE_DIR = path.join(os.tmpdir(), "family-photos-test-storage");

export function applyTestEnv() {
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
    APP_URL: "http://localhost:3000",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: TEST_STORAGE_DIR,
    MAX_UPLOAD_MB: "1",
    MAX_ZIP_PHOTOS: "10",
    ALLOW_OPEN_REGISTRATION: "false",
    SILENCE_ERROR_LOGS: "1",
  });
}
