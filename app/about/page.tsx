// app/about/page.tsx
export const dynamic = 'force-static'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 content">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p className="mt-3 text-zinc-700">
        Climate River is a clean, fast news aggregator focused on climate and
        environmental stories. Articles are automatically clustered by story,
        ranked by source credibility and freshness, and deduplicated to cut
        through the noise. Inspired by{' '}
        <a
          href="https://techmeme.com"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Techmeme
        </a>
        .
      </p>
      <p className="mt-3 text-zinc-700">
        Built with Next.js, Tailwind, and Postgres.{' '}
        <a
          href="https://github.com/dwahbe/climate-river-mvp"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Open source on GitHub
        </a>
        .
      </p>
      <p className="mt-3 text-zinc-700">
        Created by{' '}
        <a
          href="https://dylanwahbe.com"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Dylan Wahbe
        </a>
        .
      </p>
    </div>
  )
}
