// app/about/page.tsx
export const dynamic = 'force-static'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 content">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p className="mt-3 text-zinc-700">
        Climate River is a minimal, fast news river focused on climate stories.
        Sources are clustered, lightly ranked, and deduplicated by publisher to
        keep the signal high and the UI quiet.
      </p>
      <p className="mt-3 text-zinc-700">
        Built with Next.js, Tailwind, and Postgres.{' '}
        <a
          href="https://github.com/dwahbe/climate-river-mvp"
          target="_blank"
          rel="noreferrer"
        >
          View the code on GitHub
        </a>
        .
      </p>
    </div>
  )
}
