import "server-only";
import { env } from "@/lib/env";
import { LocalStorageService } from "./local";
import { S3StorageService } from "./s3";
import type { StorageService } from "./types";

export type { StorageService } from "./types";

const g = globalThis as unknown as { __storage?: StorageService };

/** 환경변수(STORAGE_DRIVER)에 따라 저장소 구현체를 선택한다. */
export function getStorage(): StorageService {
  if (g.__storage) return g.__storage;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") {
    g.__storage = new S3StorageService({
      bucket: e.S3_BUCKET!,
      region: e.AWS_REGION!,
      endpoint: e.S3_ENDPOINT,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
      presignExpiresSeconds: e.S3_PRESIGN_EXPIRES_SECONDS,
      cloudfront:
        e.CLOUDFRONT_DOMAIN && e.CLOUDFRONT_KEY_PAIR_ID && e.CLOUDFRONT_PRIVATE_KEY
          ? {
              domain: e.CLOUDFRONT_DOMAIN,
              keyPairId: e.CLOUDFRONT_KEY_PAIR_ID,
              // .env에서는 개행을 \n 으로 적을 수 있도록 처리
              privateKey: e.CLOUDFRONT_PRIVATE_KEY.replace(/\\n/g, "\n"),
            }
          : undefined,
    });
  } else {
    g.__storage = new LocalStorageService(e.STORAGE_LOCAL_DIR);
  }
  return g.__storage;
}

/** 테스트용: 저장소 교체 */
export function setStorageForTesting(s: StorageService | undefined) {
  g.__storage = s;
}
