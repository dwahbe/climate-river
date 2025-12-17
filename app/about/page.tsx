// app/about/page.tsx
import type { Metadata } from "next";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about Climate River, a climate news aggregator that brings focus to the latest climate news by organizing articles from leading outlets and ranking for trust and timeliness. Inspired by Techmeme.",
  openGraph: {
    title: "About Climate River",
    description:
      "Learn about Climate River, a climate news aggregator that brings focus to the latest climate news by organizing articles from leading outlets.",
    url: "https://climateriver.org/about",
  },
  twitter: {
    title: "About Climate River",
    description:
      "Learn about Climate River, a climate news aggregator that brings focus to the latest climate news.",
  },
  alternates: {
    canonical: "https://climateriver.org/about",
  },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-1 sm:pt-1.5 pb-8 content">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold tracking-tight">About</h1>
      </div>
      <p className="mt-3 text-zinc-700 text-pretty">
        Despite being one of the defining challenges of our time, coverage of
        the climate crisis and it’s solutions are overshadowed by the outrage
        cycle and misinformation. Climate River equips our audience with the
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
        Built with Next.js, Tailwind, and Postgres.{" "}
        <a
          href="https://github.com/dwahbe/climate-river"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          Code&nbsp;available on GitHub
        </a>
        . Inspired by{" "}
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
        Created by{" "}
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
  );
}
