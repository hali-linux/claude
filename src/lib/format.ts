/**
 * 날짜 표시. 서버 렌더링과 브라우저 렌더링 결과가 같도록(하이드레이션 불일치 방지)
 * 표시용 타임존을 고정한다. 기본값은 한국 시간.
 */
const TZ = process.env.NEXT_PUBLIC_TIMEZONE || "Asia/Seoul";

const dateFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, year: "numeric", month: "long", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export const formatDate = (d: string | Date | null | undefined) => (d ? dateFmt.format(new Date(d)) : "-");
export const formatDateTime = (d: string | Date | null | undefined) => (d ? dateTimeFmt.format(new Date(d)) : "-");

export function timeAgo(d: string | Date, now = Date.now()) {
  const diff = Math.max(0, now - new Date(d).getTime()) / 1000;
  if (diff < 60) return "방금 전";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return formatDate(d);
}

export { formatBytes } from "./upload-rules";
