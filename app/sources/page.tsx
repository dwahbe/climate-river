import type { Metadata } from "next";
import { CURATED_CLIMATE_OUTLETS } from "@/config/climateOutlets";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Climate News Sources",
  description:
    "The 40+ trusted outlets Climate River monitors for climate journalism, including The Guardian, NYT, Reuters, Carbon Brief, Inside Climate News, and more. Our curation criteria prioritize dedicated climate desks and reporting track records.",
  openGraph: {
    title: "Climate News Sources | Climate River",
    description:
      "The 40+ trusted outlets Climate River monitors for climate journalism. Curated for dedicated climate desks and reporting track records.",
    url: "https://climateriver.org/sources",
  },
  twitter: {
    title: "Climate News Sources | Climate River",
    description:
      "The 40+ trusted outlets Climate River monitors for climate journalism.",
  },
  alternates: {
    canonical: "https://climateriver.org/sources",
  },
};

type OutletGroup = {
  label: string;
  domains: string[];
};

const OUTLET_GROUPS: OutletGroup[] = [
  {
    label: "Wire Services & Major Newspapers",
    domains: [
      "apnews.com",
      "reuters.com",
      "nytimes.com",
      "theguardian.com",
      "washingtonpost.com",
      "ft.com",
      "bloomberg.com",
      "bbc.com",
      "politico.com",
    ],
  },
  {
    label: "Climate-Focused Publications",
    domains: [
      "carbonbrief.org",
      "insideclimatenews.org",
      "climatechangenews.com",
      "canarymedia.com",
      "heatmap.news",
      "grist.org",
      "cleantechnica.com",
      "energymonitor.ai",
      "carbon-pulse.com",
      "yaleclimateconnections.org",
      "eenews.net",
    ],
  },
  {
    label: "Science & Research",
    domains: [
      "nature.com",
      "scientificamerican.com",
      "nationalgeographic.com",
      "earthobservatory.nasa.gov",
      "climate.gov",
    ],
  },
  {
    label: "Analysis & Opinion",
    domains: [
      "vox.com",
      "theatlantic.com",
      "jacobin.com",
      "project-syndicate.org",
      "restofworld.org",
      "mongabay.com",
      "downtoearth.org.in",
    ],
  },
  {
    label: "Research Organizations & Institutions",
    domains: [
      "rmi.org",
      "wri.org",
      "iea.org",
      "ember-climate.org",
      "weforum.org",
      "amnesty.org",
      "news.un.org",
    ],
  },
];

export default function SourcesPage() {
  const outletsByDomain = new Map(
    CURATED_CLIMATE_OUTLETS.map((o) => [o.domain, o]),
  );

  return (
    <div className="mx-auto max-w-3xl pt-1 sm:pt-1.5 pb-10">
      <h1 className="px-4 sm:px-0 text-xl font-semibold tracking-tight">
        Sources
      </h1>
      <p className="mt-3 text-zinc-700 text-pretty">
        Climate River monitors 40+ outlets chosen
        for their dedicated climate desks, investigative track records, and
        editorial standards. We prioritize publications with sustained climate
        reporting over outlets that cover the topic only occasionally.
      </p>
      <p className="mt-2 text-zinc-700 text-pretty">
        Articles are ingested via RSS feeds and supplemented with web searches
        to catch breaking stories that may not appear in feeds. Stories are
        clustered using semantic similarity and ranked for credibility and
        timeliness. Headlines are rewritten for clarity while preserving the
        original reporting.
      </p>

      {OUTLET_GROUPS.map((group) => (
        <section key={group.label} className="mt-8">
          <h2 className="text-base font-semibold text-zinc-900 mb-3">
            {group.label}
          </h2>
          <ul className="space-y-2">
            {group.domains.map((domain) => {
              const outlet = outletsByDomain.get(domain);
              if (!outlet) return null;
              return (
                <li key={domain} className="flex flex-col">
                  <a
                    href={`https://${outlet.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-zinc-900 hover:underline"
                  >
                    {outlet.name}
                  </a>
                  {outlet.promptHint && (
                    <span className="text-xs text-zinc-500">
                      {outlet.promptHint}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
