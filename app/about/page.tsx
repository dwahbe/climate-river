// app/about/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import FAQStructuredData from "@/components/FAQStructuredData";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "About",
  description:
    "Learn about Climate River, a climate news aggregator that monitors 40+ trusted outlets, clusters stories by topic, and ranks for credibility. Inspired by Techmeme.",
  openGraph: {
    title: "About Climate River",
    description:
      "Learn about Climate River, a climate news aggregator that monitors 40+ trusted outlets, clusters stories by topic, and ranks for credibility.",
    url: "https://climateriver.org/about",
  },
  twitter: {
    title: "About Climate River",
    description:
      "Learn about Climate River, a climate news aggregator that monitors 40+ trusted outlets and clusters stories by topic.",
  },
  alternates: {
    canonical: "https://climateriver.org/about",
  },
};

const FAQ_ITEMS = [
  {
    question: "What is Climate River?",
    answer:
      "Climate River is a climate news aggregator that monitors 40+ trusted outlets via RSS feeds and web searches, then organizes their reporting by story. Instead of visiting dozens of sites, you get a single ranked feed of the most important climate news, updated continuously throughout the day.",
  },
  {
    question: "How often is Climate River updated?",
    answer:
      "New articles are ingested multiple times per day via RSS feeds and web searches. Stories are re-ranked and clustered continuously, so the homepage always reflects the latest developments.",
  },
  {
    question: "How are stories ranked?",
    answer:
      "Stories are ranked using a combination of source credibility, timeliness, and coverage breadth. Articles that appear across multiple trusted outlets are weighted higher, surfacing stories with the broadest editorial consensus.",
  },
  {
    question: "Why are some headlines rewritten?",
    answer:
      "Headlines are rewritten for clarity and accuracy using AI, following the Techmeme style. The goal is to describe the news event plainly rather than use clickbait. Original sources are always linked and clearly attributed.",
  },
  {
    question: "How can I get climate news updates?",
    answer:
      "You can subscribe to the Climate River RSS feed at climateriver.org/feed.xml using any feed reader. The feed includes the top 30 stories, updated every 5 minutes.",
  },
];

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl pt-1 sm:pt-1.5 pb-10">
      <FAQStructuredData items={FAQ_ITEMS} />

      <div className="flex items-center justify-between mb-4">
        <h1 className="px-4 sm:px-0 text-xl font-semibold tracking-tight">
          About
        </h1>
      </div>
      <p className="mt-3 text-zinc-700 text-pretty">
        Despite being one of the defining challenges of our time, coverage of
        the climate crisis and its solutions are overshadowed by the outrage
        cycle and misinformation. Climate River equips our audience with the
        latest and most credible news on the crisis. This is done by aggregating
        articles from leading outlets, improving headlines for accuracy, and
        ranking for trust and timeliness.
      </p>
      <p className="mt-3 text-zinc-700 text-pretty">
        If you have feedback or suggestions, please email me at
        contact@climateriver.org
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
      <hr className="my-4 border-zinc-200" />

      <h2 className="mt-8 text-base font-semibold text-zinc-900">
        How it works
      </h2>
      <p className="mt-2 text-zinc-700 text-pretty">
        Climate River monitors{" "}
        <Link
          href="/sources"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          40+ trusted outlets
        </Link>{" "}
        via RSS feeds and supplements them with web searches to catch stories
        that may not appear in feeds. Incoming articles are grouped into story
        clusters using semantic similarity — so if five outlets cover the same
        event, they appear together as one story. Headlines are rewritten for
        clarity, and stories are ranked based on source credibility, timeliness,
        and how many outlets are covering them.
      </p>
      <p className="mt-2 text-zinc-700 text-pretty">
        Stories are organized into{" "}
        <Link
          href="/categories"
          className="underline decoration-zinc-300 hover:decoration-zinc-500"
        >
          six categories
        </Link>
        :{" "}
        <span style={{ color: "#3B82F6" }}>government policy</span>,{" "}
        <span style={{ color: "#EC4899" }}>activism</span>,{" "}
        <span style={{ color: "#06B6D4" }}>business</span>,{" "}
        <span style={{ color: "#EF4444" }}>climate impacts</span>,{" "}
        <span style={{ color: "#10B981" }}>clean technology</span>, and{" "}
        <span style={{ color: "#8B5CF6" }}>research</span>.
      </p>
      <p className="mt-2 text-zinc-700 text-pretty">
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

      <h2 className="mt-8 text-base font-semibold text-zinc-900">
        Frequently asked questions
      </h2>
      <dl className="mt-3 space-y-4">
        {FAQ_ITEMS.map((item) => (
          <div key={item.question}>
            <dt className="text-sm font-medium text-zinc-900">
              {item.question}
            </dt>
            <dd className="mt-1 text-sm text-zinc-600 text-pretty">
              {item.answer}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
