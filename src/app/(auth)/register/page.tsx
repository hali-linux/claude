import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";
import { RegisterForm } from "@/components/auth/register-form";
import { findValidInvitation } from "@/services/invitation-service";

export const metadata: Metadata = { title: "회원가입" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const { invite } = await searchParams;
  if (await getCurrentUser()) redirect(invite ? `/invite/${encodeURIComponent(invite)}` : "/");

  const invitation = invite ? await findValidInvitation(invite) : null;
  const isFirstUser = (await prisma.user.count()) === 0;
  const openRegistration = isFirstUser || env().ALLOW_OPEN_REGISTRATION;

  if (invite && !invitation) {
    return (
      <div className="text-center">
        <p className="text-4xl">⏰</p>
        <h2 className="mt-3 text-lg font-bold">초대 링크를 사용할 수 없어요</h2>
        <p className="mt-2 text-sm text-stone-500">링크가 만료되었거나 이미 사용되었습니다. 가족 관리자에게 새 초대 링크를 요청해주세요.</p>
      </div>
    );
  }

  if (!invitation && !openRegistration) {
    return (
      <div className="text-center">
        <p className="text-4xl">💌</p>
        <h2 className="mt-3 text-lg font-bold">초대받은 가족만 가입할 수 있어요</h2>
        <p className="mt-2 text-sm text-stone-500">가족 관리자에게 초대 링크를 요청해주세요.</p>
        <Link href="/login" className="btn-secondary mt-6 w-full">로그인으로 돌아가기</Link>
      </div>
    );
  }

  return (
    <>
      <h2 className="mb-1 text-lg font-bold">회원가입</h2>
      {invitation ? (
        <p className="mb-5 text-sm text-stone-500">
          <b className="text-stone-700">{invitation.family.name}</b>에 초대되었어요.
        </p>
      ) : (
        <p className="mb-5 text-sm text-stone-500">
          {isFirstUser ? "첫 번째 사용자로 가입하면 서비스 관리자가 됩니다." : "가입하면 새 가족 사진첩이 만들어져요."}
        </p>
      )}
      <RegisterForm inviteToken={invitation ? invite : undefined} inviteEmail={invitation?.email} askFamilyName={!invitation} />
      <p className="mt-6 text-center text-sm text-stone-500">
        이미 계정이 있나요?{" "}
        <Link href={invite ? `/login?next=${encodeURIComponent(`/invite/${invite}`)}` : "/login"} className="font-semibold text-brand-600">
          로그인
        </Link>
      </p>
    </>
  );
}
