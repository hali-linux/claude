import "server-only";
import { z } from "zod";

/**
 * 환경변수 검증.
 * 잘못된 설정으로 서버가 조용히 불안전하게 동작하는 것을 막기 위해
 * 최초 접근 시 zod로 검증하고, 실패하면 즉시 예외를 던진다.
 */
const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL이 필요합니다."),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET은 최소 32자 이상의 무작위 문자열이어야 합니다."),
    APP_URL: z.url().default("http://localhost:3000"),

    ALLOW_OPEN_REGISTRATION: bool,
    SESSION_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),

    MAX_UPLOAD_MB: z.coerce.number().min(1).max(200).default(30),
    MAX_ZIP_PHOTOS: z.coerce.number().int().min(10).max(5000).default(300),
    TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default("./storage"),

    S3_BUCKET: z.string().optional(),
    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    S3_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

    CLOUDFRONT_DOMAIN: z.string().optional(),
    CLOUDFRONT_KEY_PAIR_ID: z.string().optional(),
    CLOUDFRONT_PRIVATE_KEY: z.string().optional(),

    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("우리 가족 사진 <no-reply@example.com>"),

    TRUST_PROXY: bool,
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "s3") {
      if (!env.S3_BUCKET) ctx.addIssue({ code: "custom", message: "S3_BUCKET이 필요합니다.", path: ["S3_BUCKET"] });
      if (!env.AWS_REGION) ctx.addIssue({ code: "custom", message: "AWS_REGION이 필요합니다.", path: ["AWS_REGION"] });
    }
    if (env.NODE_ENV === "production" && env.AUTH_SECRET.includes("change-me")) {
      ctx.addIssue({ code: "custom", message: "운영환경에서는 기본 AUTH_SECRET을 사용할 수 없습니다.", path: ["AUTH_SECRET"] });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // 값 자체는 출력하지 않고 어떤 키가 잘못되었는지만 보여준다(비밀값 노출 방지).
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`환경변수 설정 오류\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** 테스트에서 환경변수를 바꾼 뒤 다시 읽을 때 사용 */
export function resetEnvCache() {
  cached = null;
}

export const isProduction = () => env().NODE_ENV === "production";
