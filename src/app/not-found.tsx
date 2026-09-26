import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4">
      <div className="card max-w-md p-8 text-center">
        <p className="text-4xl">🔍</p>
        <h1 className="mt-3 text-lg font-bold">페이지를 찾을 수 없어요</h1>
        <p className="mt-2 text-sm text-stone-500">삭제되었거나 볼 수 있는 권한이 없는 페이지입니다.</p>
        <Link href="/" className="btn-primary mt-6">홈으로</Link>
      </div>
    </div>
  );
}
