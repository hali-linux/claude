import type { Metadata } from "next";
import Link from "next/link";
import { formatBytes, formatDateTime } from "@/lib/format";
import { requireFamilyContext } from "@/lib/page-context";
import { env } from "@/lib/env";
import { getFamilyStats } from "@/services/admin-service";
import { listMembers } from "@/services/family-service";
import { listInvitations } from "@/services/invitation-service";
import { listTrash } from "@/services/photo-service";
import { PageHeader, Section } from "@/components/section";
import { AdminMembers } from "@/components/admin/admin-members";
import { AdminInvites } from "@/components/admin/admin-invites";
import { AdminTrash } from "@/components/admin/admin-trash";

export const metadata: Metadata = { title: "관리자" };

export default async function AdminPage() {
  const { user, family, isFamilyAdmin } = await requireFamilyContext();
  if (!isFamilyAdmin) {
    // MEMBER는 관리자 페이지에 접근할 수 없다 (API에서도 동일하게 검사)
    return (
      <div className="card mx-auto mt-10 max-w-md p-8 text-center">
        <p className="text-4xl">🔒</p>
        <h1 className="mt-3 text-lg font-bold">가족 관리자만 볼 수 있는 페이지예요</h1>
        <Link href="/" className="btn-primary mt-6">홈으로</Link>
      </div>
    );
  }

  const [stats, members, invitations, trash] = await Promise.all([
    getFamilyStats(user, family.id),
    listMembers(user, family.id),
    listInvitations(user, family.id),
    listTrash(user, family.id),
  ]);

  const cards = [
    { label: "전체 사진", value: `${stats.photoCount.toLocaleString()}장` },
    { label: "저장공간", value: formatBytes(stats.storageBytes) },
    { label: "가족 구성원", value: `${stats.memberCount}명` },
    { label: "앨범", value: `${stats.albumCount}개` },
  ];

  return (
    <div className="space-y-8">
      <PageHeader title="🛠️ 관리자" description={`${family.name} 관리`} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="card p-4">
            <p className="text-xs text-stone-500">{c.label}</p>
            <p className="mt-1 text-xl font-bold text-stone-900 tabular-nums">{c.value}</p>
          </div>
        ))}
      </div>

      <Section title="사용자별 업로드 현황">
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs text-stone-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">이름</th>
                <th className="px-4 py-2.5 text-right font-medium">사진</th>
                <th className="px-4 py-2.5 text-right font-medium">용량</th>
                <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">마지막 업로드</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {stats.uploaders.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-stone-500">아직 업로드된 사진이 없어요.</td>
                </tr>
              )}
              {stats.uploaders.map((u) => (
                <tr key={u.userId ?? "none"}>
                  <td className="px-4 py-2.5 font-medium">{u.name}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{u.photoCount.toLocaleString()}장</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatBytes(u.storageBytes)}</td>
                  <td className="hidden px-4 py-2.5 text-right text-stone-500 sm:table-cell">{formatDateTime(u.lastUploadAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="가족 구성원 초대">
        <AdminInvites
          familyId={family.id}
          ttlHours={env().INVITATION_TTL_HOURS}
          invitations={invitations.map((i) => ({
            ...i,
            expiresAt: i.expiresAt.toISOString(),
            acceptedAt: i.acceptedAt?.toISOString() ?? null,
            revokedAt: i.revokedAt?.toISOString() ?? null,
            createdAt: i.createdAt.toISOString(),
          }))}
        />
      </Section>

      <Section title="가족 구성원 관리">
        <AdminMembers familyId={family.id} currentUserId={user.id} members={members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() }))} />
      </Section>

      <Section title="앨범 관리" href="/albums" linkLabel="앨범으로 이동">
        <p className="card p-4 text-sm text-stone-600">앨범 화면에서 앨범을 만들고, 앨범을 열어 수정·삭제·대표사진 지정을 할 수 있어요.</p>
      </Section>

      <Section title={`휴지통 (${stats.trashCount}장)`}>
        <p className="px-1 text-xs text-stone-500">
          삭제된 사진은 {env().TRASH_RETENTION_DAYS}일 동안 보관된 뒤 자동으로 영구 삭제됩니다(정리 스크립트 실행 시).
        </p>
        <AdminTrash familyId={family.id} items={trash} />
      </Section>
    </div>
  );
}
