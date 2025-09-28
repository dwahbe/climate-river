// app/about/page.tsx
export const dynamic = 'force-static'

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 content">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p className="mt-3 text-zinc-700 text-pretty">
        Despite being one of the defining crises of our time, the climate crisis
        is often overshadowed by political maneuvering and the outrage cycle.
        Climate River brings focus to the latest climate news by aggregating
        articles from leading outlets, organizing by story, and ranking for
        trust and timeliness. Inspired by{' '}
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
      <p className="mt-3 text-zinc-700 text-pretty">
        If you have feedback or suggestions, please email me at
        contact@climateriver.org
      </p>
      <hr className="my-4 border-zinc-200" />
      <p className="mt-3 text-zinc-700 text-pretty">
        Built with Next.js, Tailwind, and Postgres.{' '}
        <a
          href="https://github.com/dwahbe/climate-river"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Code&nbsp;available on GitHub
        </a>
        .
      </p>

      <p className="mt-3 text-zinc-700 text-pretty">
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
      <details className="group mt-8 mb-8 rounded-xl p-2 border border-[#096] border-spacing-1 open:bg-zinc-50 transition-colors grid">
        <summary className="font-sans font-medium group-open:text-zinc-900 rounded-b-lg transition-colors cursor-pointer pl-1 flex items-center gap-2 outline-offset-8 group-open:outline-zinc-300 overflow-clip">
          <svg
            className="text-zinc-600 -rotate-45 group-open:rotate-0 transition-transform"
            fill-rule="evenodd"
            clip-rule="evenodd"
            stroke-linejoin="round"
            stroke-miterlimit="1.414"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            viewBox="0 0 32 32"
            preserveAspectRatio="xMidYMid meet"
            fill="currentColor"
            width="24"
            height="24"
          >
            <path d="M11.121,9.707c-0.39,-0.391 -1.024,-0.391 -1.414,0c-0.391,0.39 -0.391,1.024 0,1.414l4.95,4.95l-4.95,4.95c-0.391,0.39 -0.391,1.023 0,1.414c0.39,0.39 1.024,0.39 1.414,0l4.95,-4.95l4.95,4.95c0.39,0.39 1.023,0.39 1.414,0c0.39,-0.391 0.39,-1.024 0,-1.414l-4.95,-4.95l4.95,-4.95c0.39,-0.39 0.39,-1.024 0,-1.414c-0.391,-0.391 -1.024,-0.391 -1.414,0l-4.95,4.95l-4.95,-4.95Z"></path>
          </svg>
          Small disclaimer
        </summary>
        <div className="grid gap-6 md:gap-6 p-2 text-zinc-700 text-pretty font-mono-slabs weight-book">
          <p className="text-pretty">
            Climate River is in beta. I’m improving article clustering & scoring
            and adding more sources—especially independent and local outlets. I
            built Climate River to help people cut through the noise and
            understand the climate crisis, its impacts, and the political and
            technological solutions to ameliorate it.
          </p>
        </div>
      </details>
    </div>
  )
}
