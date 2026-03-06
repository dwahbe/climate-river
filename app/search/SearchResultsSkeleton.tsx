export default function SearchResultsSkeleton() {
  return (
    <div>
      <div className="h-4 bg-zinc-100 rounded animate-pulse w-48 mb-4" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="bg-white border-b border-zinc-200/80 px-4 py-5 sm:px-5"
        >
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-zinc-100 animate-pulse shrink-0" />
            <div className="flex-1 space-y-3">
              <div className="h-3.5 bg-zinc-100 rounded animate-pulse w-32" />
              <div className="h-5 bg-zinc-100 rounded animate-pulse w-3/4" />
              <div className="h-3.5 bg-zinc-100 rounded animate-pulse w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
