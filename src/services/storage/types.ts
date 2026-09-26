import type { Readable } from "node:stream";

/**
 * 사진 저장소 추상화 계층.
 *
 * 개발 환경: LocalStorageService (디스크, public 폴더가 아닌 곳에 저장)
 * 운영 환경: S3StorageService (Private Bucket + Presigned URL / CloudFront Signed URL)
 *
 * 비즈니스 로직(photo-service)은 이 인터페이스에만 의존하므로
 * STORAGE_DRIVER 환경변수만 바꾸면 저장소를 교체할 수 있다.
 */
export interface PutOptions {
  contentType: string;
  /** 브라우저 캐시 정책. 사진 파일은 키가 바뀌지 않으므로 private 캐시를 길게 둔다. */
  cacheControl?: string;
}

export interface SignedUrlOptions {
  /** 다운로드 시 파일명(Content-Disposition: attachment) */
  downloadName?: string;
  expiresInSeconds?: number;
}

export interface StorageService {
  readonly driver: "local" | "s3";
  put(key: string, body: Buffer, opts: PutOptions): Promise<void>;
  getStream(key: string): Promise<{ stream: Readable; size?: number; contentType?: string }>;
  delete(keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
  /**
   * 브라우저가 직접 접근할 수 있는 "만료되는" URL을 반환한다.
   * 로컬 저장소처럼 직접 URL을 만들 수 없는 경우 null을 반환하며,
   * 이때는 인증을 검사하는 API(/api/photos/:id/image)를 통해 스트리밍한다.
   */
  getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string | null>;
}

/** 저장소 키에 경로 조작 문자(.., 절대경로 등)가 들어가지 않도록 검증 */
export function assertSafeKey(key: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe storage key`);
  }
}
