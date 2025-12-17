import Link from "next/link";
import { notFound } from "next/navigation";
import RiverClusterList from "@/components/RiverClusterList";
import { getRiverData } from "@/lib/services/riverService";
import { getCategoryBySlug, CATEGORIES } from "@/lib/tagger";
import { CategoryIcon } from "@/components/categoryIcons";
import BreadcrumbStructuredData from "@/components/BreadcrumbStructuredData";
import type { Metadata } from "next";

export const revalidate = 300;
export const runtime = "nodejs";

export async function generateStaticParams() {
  return CATEGORIES.map((category) => ({
    slug: category.slug,
  }));
}

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
      <div className="mx-auto max-w-3xl px-4 sm:px-6 pt-1 sm:pt-1.5 pb-8">
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
        <RiverClusterList clusters={clusters} />
      </div>
    </>
  );
}
