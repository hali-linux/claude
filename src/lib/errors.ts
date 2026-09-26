/**
 * 사용자에게 보여줄 수 있는 에러.
 * message는 반드시 사용자 친화적인 한국어 문장이어야 하며,
 * 내부 상세 정보(스택, SQL, 라이브러리 에러명)는 절대 담지 않는다.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "ERROR",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (msg = "요청이 올바르지 않습니다.", code = "BAD_REQUEST") => new AppError(400, msg, code);
export const unauthorized = (msg = "로그인이 필요합니다.") => new AppError(401, msg, "UNAUTHORIZED");
export const forbidden = (msg = "권한이 없습니다.") => new AppError(403, msg, "FORBIDDEN");
// IDOR 방지: 다른 가족의 리소스는 "존재하지 않음"으로 응답하여 존재 여부조차 노출하지 않는다.
export const notFound = (msg = "요청한 항목을 찾을 수 없습니다.") => new AppError(404, msg, "NOT_FOUND");
export const conflict = (msg: string) => new AppError(409, msg, "CONFLICT");
export const payloadTooLarge = (msg: string) => new AppError(413, msg, "PAYLOAD_TOO_LARGE");
export const unsupportedMedia = (msg: string) => new AppError(415, msg, "UNSUPPORTED_MEDIA_TYPE");
export const tooManyRequests = (msg = "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.") =>
  new AppError(429, msg, "RATE_LIMITED");
