import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireFamilyContext } from "@/lib/page-context";
import { listMembers } from "@/services/family-service";
import { PageHeader, Section } from "@/components/section";
import { FamilyEditor } from "@/components/family/family-editor";
import { LeaveFamilyButton } from "@/components/family/leave-family-button";
import { CreateFamilyForm } from "@/components/family/create-family-form";

export const metadata: Metadata = { title: "가족" };

export default async function FamilyPage() {
  const { user, family, isFamilyAdmin, families } = await requireFamilyContext();
  const [members, counts] = await Promise.all([
    listMembers(user, family.id),
    prisma.photo.groupBy({ by: ["uploaderId"], where: { familyId: family.id, deletedAt: null }, _count: { _all: true } }),
  ]);
  const countOf = new Map(counts.map((c) => [c.uploaderId, c._count._all]));

  return (
    <div className="space-y-8">
      <PageHeader
        title={`👨‍👩‍👧‍👦 ${family.name}`}
        description={family.description ?? `가족 구성원 ${members.length}명`}
        actions={
          isFamilyAdmin ? (
            <>
              <FamilyEditor family={family} />
              <Link href="/admin" className="btn-primary">구성원 초대 · 관리</Link>
            </>
          ) : undefined
        }
      />

      <Section title={`구성원 ${members.length}명`}>
        <ul className="card divide-y divide-stone-100">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 p-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 font-bold text-brand-700">
                {m.name.slice(0, 1)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-800">
                  {m.name} {m.userId === user.id && <span className="text-xs font-normal text-stone-400">(나)</span>}
                </p>
                <p className="text-xs text-stone-500">
                  {formatDate(m.joinedAt)} 참여 · 사진 {(countOf.get(m.userId) ?? 0).toLocaleString()}장
                </p>
              </div>
              {m.role === "ADMIN" && <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">관리자</span>}
              <Link href={`/photos?uploaderId=${m.userId}`} className="text-sm text-brand-600 hover:underline">
                사진
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <LeaveFamilyButton familyId={family.id} userId={user.id} familyName={family.name} />
        </div>
      </Section>

      <Section title="다른 가족 사진첩">
        <div className="card space-y-4 p-4">
          {families.length > 1 && (
            <p className="text-sm text-stone-600">
              참여 중인 가족: {families.map((f) => f.name).join(", ")} — 화면 상단에서 가족을 바꿀 수 있어요.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-sm font-semibold text-brand-700">새 가족 사진첩 만들기 (예: 외가, 친가)</summary>
            <div className="mt-3 max-w-md">
              <CreateFamilyForm />
            </div>
          </details>
        </div>
      </Section>
    </div>
  );
}
