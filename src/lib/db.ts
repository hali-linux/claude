import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";

/**
 * Prisma Client 싱글톤.
 * - 개발 모드의 HMR에서 커넥션이 계속 늘어나지 않도록 globalThis에 보관한다.
 * - 최초 사용 시점에 생성(lazy)하여, 빌드 시점(`next build`, Docker 빌드)에는
 *   DATABASE_URL 등 런타임 환경변수가 없어도 되도록 한다.
 * 모든 쿼리는 Prisma의 파라미터 바인딩을 사용하므로 SQL Injection에 안전하다.
 * (raw query가 필요할 경우 반드시 $queryRaw 태그드 템플릿을 사용하고 $queryRawUnsafe는 금지)
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const adapter = new PrismaPg({ connectionString: env().DATABASE_URL });
    globalForPrisma.prisma = new PrismaClient({ adapter, log: ["warn", "error"] });
  }
  return globalForPrisma.prisma;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
