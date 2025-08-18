// app/about/page.tsx
export const dynamic = 'force-static'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 content">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p className="mt-3 text-zinc-700">
        Despite being a defining crisis of our time, the climate crisis often
        gets buried in the feed. Climate River brings it back to the top by
        aggregating articles from leading outlets, organizing by story, and
        ranking for trust and timeliness. Inspired by{' '}
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
        If you have feedback or suggestions, please email me at
        contact@climateriver.org
      </p>
      <hr className="my-4 border-zinc-200" />
      <p className="mt-3 text-zinc-700">
        Built with Next.js, Tailwind, and Postgres.{' '}
        <a
          href="https://github.com/dwahbe/climate-river"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Code available on GitHub
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
