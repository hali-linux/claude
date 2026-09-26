/**
 * 휴지통 정리 스크립트: 보관 기간(TRASH_RETENTION_DAYS, 기본 30일)이 지난 사진을 영구 삭제한다.
 * cron 등으로 하루 한 번 실행한다.  예) 0 4 * * * cd /app && npm run purge-trash
 */
import "dotenv/config";
import { purgeTrash } from "@/services/photo-service";
import { prisma } from "@/lib/db";

async function main() {
  const deleted = await purgeTrash();
  console.log(`휴지통 정리 완료: ${deleted}장 영구 삭제`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("휴지통 정리 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
