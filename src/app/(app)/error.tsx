"use client";

/** 예상하지 못한 오류 화면. 기술적인 에러 내용은 사용자에게 보여주지 않는다. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card mx-auto mt-10 max-w-md p-8 text-center">
      <p className="text-4xl">😢</p>
      <h1 className="mt-3 text-lg font-bold">화면을 불러오지 못했어요</h1>
      <p className="mt-2 text-sm text-stone-500">잠시 후 다시 시도해주세요. 문제가 계속되면 가족 관리자에게 알려주세요.</p>
      <button type="button" className="btn-primary mt-6" onClick={reset}>
        다시 시도
      </button>
    </div>
  );
}
