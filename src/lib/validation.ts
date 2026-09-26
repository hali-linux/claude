import { z } from "zod";

/** 입력값 검증 스키마 (서버에서 모든 입력을 검증한다) */

export const emailSchema = z
  .string({ error: "이메일을 입력해주세요." })
  .trim()
  .toLowerCase()
  .max(255, "이메일이 너무 깁니다.")
  .pipe(z.email({ error: "올바른 이메일 주소를 입력해주세요." }));

export const passwordSchema = z
  .string({ error: "비밀번호를 입력해주세요." })
  .min(8, "비밀번호는 8자 이상이어야 합니다.")
  .max(72, "비밀번호는 72자 이하여야 합니다.")
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "비밀번호는 영문과 숫자를 모두 포함해야 합니다.");

export const nameSchema = z.string({ error: "이름을 입력해주세요." }).trim().min(1, "이름을 입력해주세요.").max(50, "이름은 50자 이하여야 합니다.");

export const idSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+$/i, "잘못된 ID입니다.");

export const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  familyName: z.string().trim().max(50, "가족 이름은 50자 이하여야 합니다.").optional(),
  inviteToken: z.string().max(128).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "비밀번호를 입력해주세요.").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "현재 비밀번호를 입력해주세요.").max(200),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({ name: nameSchema });

export const familySchema = z.object({
  name: z.string().trim().min(1, "가족 이름을 입력해주세요.").max(50, "가족 이름은 50자 이하여야 합니다."),
  description: z.string().trim().max(500, "설명은 500자 이하여야 합니다.").optional().nullable(),
});

export const albumCreateSchema = z.object({
  familyId: idSchema,
  name: z.string().trim().min(1, "앨범 이름을 입력해주세요.").max(100, "앨범 이름은 100자 이하여야 합니다."),
  description: z.string().trim().max(1000, "설명은 1000자 이하여야 합니다.").optional().nullable(),
});

export const albumUpdateSchema = z.object({
  name: albumCreateSchema.shape.name.optional(),
  description: albumCreateSchema.shape.description,
  coverPhotoId: idSchema.nullable().optional(),
});

export const photoUpdateSchema = z.object({
  description: z.string().trim().max(2000, "설명은 2000자 이하여야 합니다.").nullable().optional(),
  albumId: idSchema.nullable().optional(),
  takenAt: z.coerce.date().nullable().optional(),
});

export const invitationCreateSchema = z.object({
  familyId: idSchema,
  email: emailSchema,
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
});

export const memberUpdateSchema = z.object({ role: z.enum(["ADMIN", "MEMBER"]) });

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const DATE_PRESETS = ["today", "7d", "30d", "year", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];

export const photoQuerySchema = z.object({
  familyId: idSchema.optional(),
  albumId: z.union([idSchema, z.literal("none")]).optional(),
  uploaderId: idSchema.optional(),
  q: z.string().trim().max(100).optional(),
  favorites: z.enum(["1", "true"]).optional(),
  dateField: z.enum(["taken", "uploaded"]).default("uploaded"),
  preset: z.enum(DATE_PRESETS).optional().or(z.literal("").transform(() => undefined)),
  from: dateOnly,
  to: dateOnly,
  cursor: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(48),
});
export type PhotoQuery = z.infer<typeof photoQuerySchema>;

/**
 * 날짜 프리셋 → [from, to) 범위. 서버의 로컬 타임존(TZ 환경변수, 기본 Asia/Seoul 권장) 기준.
 */
export function resolveDateRange(
  preset: DatePreset | undefined,
  from?: string,
  to?: string,
  now = new Date(),
): { gte?: Date; lt?: Date } | null {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = startOfDay(now);
  switch (preset) {
    case "today":
      return { gte: today, lt: addDays(today, 1) };
    case "7d":
      return { gte: addDays(today, -6), lt: addDays(today, 1) };
    case "30d":
      return { gte: addDays(today, -29), lt: addDays(today, 1) };
    case "year":
      return { gte: new Date(now.getFullYear(), 0, 1), lt: new Date(now.getFullYear() + 1, 0, 1) };
    case "custom":
    case undefined: {
      if (!from && !to) return null;
      const parse = (s: string) => {
        const [y, m, d] = s.split("-").map(Number);
        return new Date(y!, m! - 1, d!);
      };
      return {
        gte: from ? parse(from) : undefined,
        lt: to ? addDays(parse(to), 1) : undefined,
      };
    }
  }
}
