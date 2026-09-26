import { describe, expect, it } from "vitest";
import { passwordSchema, emailSchema, resolveDateRange } from "@/lib/validation";
import { isAllowedExtension, isAllowedDeclaredMime, formatBytes } from "@/lib/upload-rules";
import { sanitizeFileName } from "@/services/photo-service";
import { __test } from "@/lib/logger";
import { assertSafeKey } from "@/services/storage/types";
import { maskEmail } from "@/services/invitation-service";

describe("입력 검증", () => {
  it("비밀번호 정책", () => {
    expect(passwordSchema.safeParse("abc12345").success).toBe(true);
    expect(passwordSchema.safeParse("abcdefgh").success).toBe(false);
    expect(passwordSchema.safeParse("12345678").success).toBe(false);
    expect(passwordSchema.safeParse("a1").success).toBe(false);
    expect(passwordSchema.safeParse("a1".repeat(40)).success).toBe(false);
  });

  it("이메일은 소문자로 정규화된다", () => {
    expect(emailSchema.parse("  Mom@Example.COM ")).toBe("mom@example.com");
  });

  it("업로드 확장자/MIME 허용 목록", () => {
    expect(isAllowedExtension("a.JPG")).toBe(true);
    expect(isAllowedExtension("a.heic")).toBe(true);
    expect(isAllowedExtension("a.svg")).toBe(false);
    expect(isAllowedExtension("a.jpg.exe")).toBe(false);
    expect(isAllowedExtension("noext")).toBe(false);
    expect(isAllowedDeclaredMime("image/jpeg")).toBe(true);
    expect(isAllowedDeclaredMime("")).toBe(true);
    expect(isAllowedDeclaredMime("text/html")).toBe(false);
    expect(isAllowedDeclaredMime("image/svg+xml")).toBe(false);
  });

  it("파일명에서 경로와 위험 문자를 제거한다", () => {
    expect(sanitizeFileName("../../etc/passwd.jpg")).toBe("passwd.jpg");
    expect(sanitizeFileName("C:\\Users\\a\\사진.jpg")).toBe("사진.jpg");
    expect(sanitizeFileName('<script>".jpg')).toBe("script.jpg");
  });

  it("저장소 키 경로 조작 차단", () => {
    expect(() => assertSafeKey("families/a/b/original.jpg")).not.toThrow();
    expect(() => assertSafeKey("../secret")).toThrow();
    expect(() => assertSafeKey("/etc/passwd")).toThrow();
    expect(() => assertSafeKey("a/../../b")).toThrow();
  });

  it("날짜 프리셋 범위", () => {
    const now = new Date(2026, 5, 15, 13, 0, 0);
    expect(resolveDateRange("today", undefined, undefined, now)).toEqual({ gte: new Date(2026, 5, 15), lt: new Date(2026, 5, 16) });
    expect(resolveDateRange("7d", undefined, undefined, now)!.gte).toEqual(new Date(2026, 5, 9));
    expect(resolveDateRange("30d", undefined, undefined, now)!.gte).toEqual(new Date(2026, 4, 17));
    expect(resolveDateRange("year", undefined, undefined, now)).toEqual({ gte: new Date(2026, 0, 1), lt: new Date(2027, 0, 1) });
    expect(resolveDateRange("custom", "2025-12-24", "2025-12-25", now)).toEqual({ gte: new Date(2025, 11, 24), lt: new Date(2025, 11, 26) });
    expect(resolveDateRange(undefined, undefined, undefined, now)).toBeNull();
  });

  it("로그에서 민감 정보를 마스킹한다", () => {
    const out = __test.redact({ email: "a@b.c", password: "secret", nested: { sessionToken: "t", ok: 1 } }) as Record<string, unknown>;
    expect(out.password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).sessionToken).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it("기타 유틸", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(18.4 * 1024 ** 3)).toBe("18.4 GB");
    expect(maskEmail("grandma@example.com")).toBe("gr*****@example.com");
  });
});

import { safeNextPath } from "@/lib/safe-redirect";

describe("Open Redirect 방지", () => {
  it("같은 사이트 상대 경로만 허용", () => {
    expect(safeNextPath("/albums/abc")).toBe("/albums/abc");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});
