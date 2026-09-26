import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { findValidInvitation, maskEmail } from "@/services/invitation-service";
import { AcceptInviteButton } from "@/components/auth/accept-invite-button";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "가족 초대", referrer: "no-referrer" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [invitation, user] = await Promise.all([findValidInvitation(token), getCurrentUser()]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-brand-50 to-stone-50 px-4">
      <div className="card w-full max-w-sm p-6 text-center">
        {!invitation ? (
          <>
            <p className="text-4xl">⏰</p>
            <h1 className="mt-3 text-lg font-bold">초대 링크를 사용할 수 없어요</h1>
            <p className="mt-2 text-sm text-stone-500">링크가 만료되었거나 이미 사용되었습니다. 가족 관리자에게 새 초대 링크를 요청해주세요.</p>
            <Link href="/" className="btn-secondary mt-6 w-full">처음으로</Link>
          </>
        ) : (
          <>
            <p className="text-5xl">💌</p>
            <h1 className="mt-3 text-xl font-bold text-stone-900">{invitation.family.name}</h1>
            <p className="mt-2 text-sm text-stone-600">
              {invitation.invitedBy?.name ?? "가족"}님이 가족 사진첩에 초대했어요.
            </p>
            <p className="mt-1 text-xs text-stone-400">
              초대 대상: {maskEmail(invitation.email)} · {formatDateTime(invitation.expiresAt)}까지 유효
            </p>
            <div className="mt-6 space-y-2">
              {user ? (
                user.email === invitation.email ? (
                  <AcceptInviteButton token={token} />
                ) : (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    지금 로그인한 계정({user.email})은 초대받은 이메일과 달라요. 초대받은 이메일 계정으로 로그인해주세요.
                  </p>
                )
              ) : (
                <>
                  <Link href={`/register?invite=${encodeURIComponent(token)}`} className="btn-primary w-full py-3">
                    가입하고 참여하기
                  </Link>
                  <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`} className="btn-secondary w-full py-3">
                    이미 계정이 있어요 (로그인)
                  </Link>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
