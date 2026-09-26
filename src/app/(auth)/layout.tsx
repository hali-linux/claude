export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-stone-50 px-4 py-10">
      <div className="mb-8 text-center">
        <div className="text-5xl">📸</div>
        <h1 className="mt-3 text-2xl font-bold text-stone-900">우리 가족 사진</h1>
        <p className="mt-1 text-sm text-stone-500">가족끼리만 안전하게 나누는 추억 보관함</p>
      </div>
      <div className="card w-full max-w-sm p-6">{children}</div>
    </div>
  );
}
