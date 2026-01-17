"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import CategoryChips, { type CategoryInfo } from "@/components/CategoryChips";
import FeedCardGrid from "@/components/FeedCardGrid";
import { CategoryIcon } from "@/components/categoryIcons";
import type { Cluster } from "@/lib/models/cluster";
import type { CategorySlug } from "@/lib/tagger";

type CategoryStream = {
  slug: CategorySlug;
  clusters: Cluster[];
};

type CategoryIndexClientProps = {
  categories: CategoryInfo[];
  streams: CategoryStream[];
};

type SelectedCategory = CategorySlug | "all";

export default function CategoryIndexClient({
  categories,
  streams,
}: CategoryIndexClientProps) {
  const [selectedSlug, setSelectedSlug] = useState<SelectedCategory>("all");

  const visibleStreams = useMemo(() => {
    if (selectedSlug === "all") {
      return streams;
    }

    return streams.filter((stream) => stream.slug === selectedSlug);
  }, [streams, selectedSlug]);

  const categoryBySlug = useMemo(() => {
    return new Map(categories.map((category) => [category.slug, category]));
  }, [categories]);

  return (
    <>
      <CategoryChips
        mode="filter"
        categories={categories}
        selectedSlug={selectedSlug}
        onSelect={setSelectedSlug}
        className="mt-4 px-4 sm:px-0"
      />

      <div className="mt-8 space-y-10">
        {visibleStreams.map(({ slug, clusters }) => {
          const category = categoryBySlug.get(slug);
          if (!category) {
            return null;
          }

          return (
            <section key={slug} className="space-y-4">
              <div>
                <h2 className="text-base font-semibold tracking-tight text-zinc-900">
                  {category.name}
                  <CategoryIcon
                    slug={category.slug}
                    className="ml-1.5 inline h-4 w-4 align-[-0.15em]"
                    style={{ color: category.color }}
                  />
                </h2>
                <p className="mt-1 text-sm text-zinc-500">
                  {category.description}
                </p>
              </div>

              <FeedCardGrid
                clusters={clusters}
                emptyMessage="No elevated stories at the moment. Check back soon."
              />

              <Link
                href={`/categories/${category.slug}`}
                className="inline-flex items-center gap-1 text-sm font-medium text-sky-600 hover:text-sky-700"
              >
                View more stories <span aria-hidden="true">→</span>
              </Link>
            </section>
          );
        })}
      </div>
    </>
  );
}
