import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Docker/로드밸런서 헬스체크. 내부 정보는 노출하지 않는다. */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}
