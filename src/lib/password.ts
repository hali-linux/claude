import "server-only";
import bcrypt from "bcryptjs";

/**
 * 비밀번호 해싱: bcrypt(cost 12).
 * - 평문 비밀번호는 저장/로그 출력하지 않는다.
 * - bcrypt는 72바이트까지만 사용하므로 입력 길이를 72자 이하로 검증한다(validation.ts).
 * - 순수 JS 구현(bcryptjs)을 사용해 네이티브 빌드 없이 Docker/서버리스 어디서나 동작한다.
 */
const COST = process.env.NODE_ENV === "test" ? 4 : 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// 존재하지 않는 이메일로 로그인할 때도 동일한 시간이 걸리도록 비교에 사용하는 더미 해시
// (응답 시간으로 가입 여부를 추측하는 계정 열거 공격 방지)
let dummyHash: string | null = null;
export async function dummyVerify(password: string) {
  dummyHash ??= await bcrypt.hash("dummy-password-for-timing", COST);
  await bcrypt.compare(password, dummyHash);
}
