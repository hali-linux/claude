import "server-only";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * 메일 발송. SMTP_URL이 설정되지 않으면 발송하지 않고 false를 반환한다.
 * (이 경우 관리자 화면에서 초대 링크를 복사해 카카오톡/문자 등으로 직접 전달하면 된다.)
 * 초대 링크(토큰)는 민감 정보이므로 로그에 남기지 않는다.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const { SMTP_URL, MAIL_FROM } = env();
  if (!SMTP_URL) return false;
  try {
    const transport = nodemailer.createTransport(SMTP_URL);
    await transport.sendMail({ from: MAIL_FROM, to, subject, text });
    return true;
  } catch (err) {
    logger.error("메일 발송 실패", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
