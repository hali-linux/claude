import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "로그인" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const nextPath = safeNextPath(next);
  if (await getCurrentUser()) redirect(nextPath);
  return (
    <>
      <h2 className="mb-5 text-lg font-bold">로그인</h2>
      <LoginForm next={nextPath} />
      <p className="mt-6 text-center text-sm text-stone-500">
        처음이신가요? <Link href="/register" className="font-semibold text-brand-600">회원가입</Link>
      </p>
    </>
  );
}
