import "server-only";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl as presign } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as cloudfrontSign } from "@aws-sdk/cloudfront-signer";
import { assertSafeKey, type PutOptions, type SignedUrlOptions, type StorageService } from "./types";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  presignExpiresSeconds: number;
  cloudfront?: { domain: string; keyPairId: string; privateKey: string };
}

/**
 * AWS S3 저장소 (운영환경).
 *
 * 보안 설계
 *  - 버킷은 반드시 Private(Block Public Access ON). 객체에 public-read ACL을 절대 사용하지 않는다.
 *  - 브라우저에는 짧은 시간(기본 15분)만 유효한 Presigned URL을 발급한다.
 *    URL 발급 전에 서버에서 로그인/가족 권한을 검사하므로 권한 없는 사용자는 URL을 얻을 수 없다.
 *  - CloudFront 설정 시 OAC(Origin Access Control)로 버킷을 보호하고
 *    CloudFront Signed URL을 발급한다(전 세계 캐시로 빠른 로딩).
 *  - 서버측 암호화(SSE-S3, AES256)를 적용한다.
 *  - 자격 증명은 가능한 한 IAM Role(EC2/ECS Task Role)을 사용하고, 액세스 키는 선택 사항이다.
 */
export class S3StorageService implements StorageService {
  readonly driver = "s3" as const;
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint || undefined,
      forcePathStyle: cfg.forcePathStyle,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined, // 미설정 시 기본 자격 증명 체인(IAM Role 등) 사용
    });
  }

  async put(key: string, body: Buffer, opts: PutOptions) {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl ?? "private, max-age=31536000, immutable",
        ServerSideEncryption: "AES256",
      }),
    );
  }

  async getStream(key: string) {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    const body = res.Body;
    if (!body) throw new Error("Empty S3 object body");
    const stream = body instanceof Readable ? body : Readable.fromWeb(body.transformToWebStream() as never);
    return { stream, size: res.ContentLength, contentType: res.ContentType };
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      chunk.forEach(assertSafeKey);
      if (chunk.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.cfg.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string, opts: SignedUrlOptions = {}) {
    assertSafeKey(key);
    const expiresIn = opts.expiresInSeconds ?? this.cfg.presignExpiresSeconds;
    const disposition = opts.downloadName
      ? `attachment; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`
      : undefined;

    if (this.cfg.cloudfront) {
      const { domain, keyPairId, privateKey } = this.cfg.cloudfront;
      const url = new URL(`https://${domain}/${key.split("/").map(encodeURIComponent).join("/")}`);
      if (disposition) url.searchParams.set("response-content-disposition", disposition);
      return cloudfrontSign({
        url: url.toString(),
        keyPairId,
        privateKey,
        dateLessThan: new Date(Date.now() + expiresIn * 1000).toISOString(),
      });
    }

    return presign(
      this.client,
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, ResponseContentDisposition: disposition }),
      { expiresIn },
    );
  }
}
