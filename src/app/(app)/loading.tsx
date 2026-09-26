export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="불러오는 중">
      <div className="h-8 w-40 rounded-lg bg-stone-200" />
      <div className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {Array.from({ length: 18 }, (_, i) => (
          <div key={i} className="aspect-square bg-stone-200" />
        ))}
      </div>
    </div>
  );
}
