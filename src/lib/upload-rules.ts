/**
 * 업로드 허용 규칙 (클라이언트 사전 검증 + 서버 검증에서 공통 사용).
 * 클라이언트 검증은 UX를 위한 것일 뿐이며, 실제 보안 검증은 반드시 서버에서 다시 수행한다.
 */
export const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif"] as const;

export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
] as const;

export const ACCEPT_ATTR = "image/jpeg,image/png,image/gif,image/webp,image/avif,image/heic,image/heif,.heic,.heif";

export function fileExtension(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isAllowedExtension(name: string) {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

export function isAllowedDeclaredMime(type: string) {
  // 일부 브라우저(특히 HEIC)는 빈 문자열이나 octet-stream을 보내므로 허용하고 실제 내용으로 판별한다.
  return !type || type === "application/octet-stream" || (ALLOWED_MIME_TYPES as readonly string[]).includes(type);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
