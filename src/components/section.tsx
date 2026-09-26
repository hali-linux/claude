import Link from "next/link";

export function Section({ title, href, linkLabel = "전체 보기", children }: { title: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between px-1">
        <h2 className="text-lg font-bold text-stone-900">{title}</h2>
        {href && (
          <Link href={href} className="text-sm font-medium text-brand-600 hover:underline">
            {linkLabel} →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-stone-900">{title}</h1>
        {description && <div className="mt-1 text-sm text-stone-500">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
