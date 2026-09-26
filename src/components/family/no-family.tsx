import { CreateFamilyForm } from "./create-family-form";
import { LogoutButton } from "../settings/logout-button";

/** 참여 중인 가족이 없을 때(예: 구성원에서 제외됨) 보여주는 화면 */
export function NoFamily({ userName }: { userName: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-brand-50 to-stone-50 px-4">
      <div className="card w-full max-w-md p-6">
        <p className="text-center text-4xl">🏡</p>
        <h1 className="mt-3 text-center text-lg font-bold">{userName}님, 아직 참여 중인 가족이 없어요</h1>
        <p className="mt-2 text-center text-sm text-stone-500">
          가족 관리자에게 초대 링크를 받거나, 새 가족 사진첩을 만들어보세요.
        </p>
        <div className="mt-6">
          <CreateFamilyForm />
        </div>
        <div className="mt-4 text-center">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
