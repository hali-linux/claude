import type { Metadata } from "next";
import { getPageContext } from "@/lib/page-context";
import { PageHeader } from "@/components/section";
import { PasswordForm, ProfileForm } from "@/components/settings/profile-form";
import { LogoutButton } from "@/components/settings/logout-button";

export const metadata: Metadata = { title: "설정" };

export default async function SettingsPage() {
  const { user } = await getPageContext();
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="⚙️ 설정" />
      <section className="card p-5">
        <h2 className="mb-4 font-bold">내 정보</h2>
        <ProfileForm name={user.name} email={user.email} />
      </section>
      <section className="card p-5">
        <h2 className="mb-4 font-bold">비밀번호 변경</h2>
        <PasswordForm />
      </section>
      <section className="card flex items-center justify-between p-5">
        <div>
          <h2 className="font-bold">로그아웃</h2>
          <p className="text-sm text-stone-500">이 기기에서 로그아웃합니다.</p>
        </div>
        <LogoutButton className="btn-secondary" />
      </section>
    </div>
  );
}
