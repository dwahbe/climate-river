// app/about/page.tsx
import type { Metadata } from 'next'

export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'About',
  description:
    'Learn about Climate River, a climate news aggregator that brings focus to the latest climate news by organizing articles from leading outlets and ranking for trust and timeliness. Inspired by Techmeme.',
  openGraph: {
    title: 'About Climate River',
    description:
      'Learn about Climate River, a climate news aggregator that brings focus to the latest climate news by organizing articles from leading outlets.',
    url: 'https://climateriver.org/about',
  },
  twitter: {
    title: 'About Climate River',
    description:
      'Learn about Climate River, a climate news aggregator that brings focus to the latest climate news.',
  },
  alternates: {
    canonical: 'https://climateriver.org/about',
  },
}

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-1 sm:pt-1.5 pb-8 content">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">About</h1>
        {/* <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {CATEGORIES.map((category) => {
              const Icon = CATEGORY_ICONS[category.slug]
              if (!Icon) return null

              const tooltipId = `about-category-${category.slug}-tooltip`

              return (
                <span
                  key={category.slug}
                  tabIndex={0}
                  className="relative group inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-300 focus-visible:rounded-full"
                  aria-label={`${category.name}: ${category.description}`}
                  aria-describedby={tooltipId}
                  role="img"
                >
                  <Icon
                    className="w-5 h-5 transition-transform duration-150 group-hover:scale-110 group-focus-visible:scale-110"
                    style={{ color: category.color }}
                    aria-hidden="true"
                    focusable="false"
                  />
                  <span
                    id={tooltipId}
                    className="pointer-events-none absolute left-1/2 bottom-full z-10 mb-2 w-max max-w-xs -translate-x-1/2 rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                    role="tooltip"
                  >
                    <span className="block">{category.name}</span>
                    <span className="mt-0.5 block text-[0.675rem] font-normal text-zinc-100/80">
                      {category.description}
                    </span>
                  </span>
                </span>
              )
            })}
          </div>

          <div className="w-px h-6 bg-zinc-300" />

          <ClimateRiverLogo size="lg" variant="colored" animated={true} />
        </div> */}
      </div>
      <p className="mt-3 text-zinc-700 text-pretty">
        Despite being one of the defining challenges of our time, coverage of
        the climate crisis and it's solutions are overshadowed by the outrage
        cycle and misinformation. Climate River equips its audience with the
        latest and most credible news on the crisis. This is done by aggregating
        articles from leading outlets, improving headlines for accuracy, and
        ranking for trust and timeliness.
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
        . Inspired by{' '}
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
