import type { NextConfig } from "next";

/**
 * 보안 헤더 (모든 응답에 적용).
 * CSP(요청마다 nonce 필요)와 HSTS(APP_URL이 https일 때만)는 src/proxy.ts에서 런타임에 설정한다.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" }, // 클릭재킹 방지
  { key: "X-Content-Type-Options", value: "nosniff" }, // MIME 스니핑 방지
  // 초대 링크(토큰 포함 URL)가 외부 사이트로 Referer를 통해 새지 않도록 same-origin
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  // Docker 이미지 크기를 줄이기 위해 필요한 파일만 포함하는 standalone 빌드
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["sharp", "archiver", "@prisma/client", "pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
