import Link from "next/link";
import { notFound } from "next/navigation";
import FeedCardGrid from "@/components/FeedCardGrid";
import { getRiverData } from "@/lib/services/riverService";
import { getCategoryBySlug } from "@/lib/tagger";
import { CategoryIcon } from "@/components/categoryIcons";
import BreadcrumbStructuredData from "@/components/BreadcrumbStructuredData";
import type { Metadata } from "next";

export const revalidate = 300;
export const dynamicParams = true;

// Skip static generation at build time to avoid DB timeout
// Pages render on-demand with ISR caching (revalidate=300)

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const category = getCategoryBySlug(params.slug);

  if (!category) {
    return {};
  }

  const title = `${category.name} Climate News`;
  const description = `${category.description}. Stay updated with the latest ${category.name.toLowerCase()} news and developments in climate change.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `https://climateriver.org/categories/${category.slug}`,
    },
    twitter: {
      title,
      description,
    },
    alternates: {
      canonical: `https://climateriver.org/categories/${category.slug}`,
    },
  };
}

export default async function CategoryDetailPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const category = getCategoryBySlug(params.slug);

  if (!category) {
    notFound();
  }

  const clusters = await getRiverData({
    view: "top",
    category: category.slug,
  });

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { name: "Home", url: "https://climateriver.org" },
          { name: "Categories", url: "https://climateriver.org/categories" },
          {
            name: category.name,
            url: `https://climateriver.org/categories/${category.slug}`,
          },
        ]}
      />
      <div className="w-full pt-1 sm:pt-1.5 pb-10">
        <Link
          href="/categories"
          className="text-sm text-zinc-500 hover:underline"
        >
          ← All categories
        </Link>
        <h1 className="mt-2 mb-3 flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span>{category.name}</span>
          <CategoryIcon
            slug={category.slug}
            className="h-5 w-5"
            style={{ color: category.color }}
          />
        </h1>
        <FeedCardGrid
          clusters={clusters}
          emptyMessage="No stories available right now."
        />
      </div>
    </>
  );
}
