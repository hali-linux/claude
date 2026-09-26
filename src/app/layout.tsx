import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: { default: "우리 가족 사진", template: "%s · 우리 가족 사진" },
  description: "가족끼리만 안전하게 사진을 나누는 공간",
  // 가족 사진 서비스는 검색엔진에 노출되지 않도록 한다
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "가족사진", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#fff8f1",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
