import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { assertSafeKey, type StorageService } from "./types";

/**
 * 로컬 디스크 저장소 (개발/소규모 자가호스팅용).
 *
 * - 파일은 Next.js의 public 폴더가 아닌 별도 디렉터리(STORAGE_LOCAL_DIR)에 저장된다.
 *   따라서 URL만으로는 절대 접근할 수 없고, 반드시 인증을 거치는 API를 통해서만 제공된다.
 * - 키 검증 + 경로 정규화로 디렉터리 탈출(Path Traversal)을 막는다.
 */
export class LocalStorageService implements StorageService {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string) {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error("Unsafe storage key");
    return full;
  }

  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    // 임시 파일에 쓴 뒤 rename → 쓰는 도중 읽히는 반쪽짜리 파일 방지
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, full);
  }

  async getStream(key: string) {
    const full = this.resolve(key);
    const s = await stat(full);
    return { stream: createReadStream(full), size: s.size };
  }

  async delete(keys: string[]) {
    await Promise.all(keys.map((k) => rm(this.resolve(k), { force: true })));
  }

  async exists(key: string) {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl() {
    return null;
  }
}
