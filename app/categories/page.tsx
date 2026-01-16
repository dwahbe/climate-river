import { CATEGORIES } from "@/lib/tagger";
import { getRiverData } from "@/lib/services/riverService";
import CategoryIndexClient from "@/app/categories/CategoryIndexClient";
import type { Metadata } from "next";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Categories",
  description:
    "Explore climate news by category: Government policy and regulations, Activism and protests, Business and corporate action, Climate impacts and extreme weather, Clean technology and renewables, Research and scientific discoveries.",
  openGraph: {
    title: "Climate News Categories",
    description:
      "Explore climate news organized by category: Government, Activism, Business, Impacts, Tech, and Research.",
    url: "https://climateriver.org/categories",
  },
  twitter: {
    title: "Climate News Categories",
    description: "Explore climate news organized by category.",
  },
  alternates: {
    canonical: "https://climateriver.org/categories",
  },
};

export default async function CategoriesPage() {
  const categories = CATEGORIES.map(({ slug, name, description, color }) => ({
    slug,
    name,
    description,
    color,
  }));
  const categoryStreams = await Promise.all(
    CATEGORIES.map(async (category) => {
      const clusters = await getRiverData({
        view: "top",
        category: category.slug,
        limit: 6,
      });

      return {
        slug: category.slug,
        clusters,
      };
    }),
  );

  return (
    <div className="w-full pt-1 sm:pt-1.5 pb-10">
      <h1 className="text-xl font-semibold tracking-tight">Categories</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Explore the climate beats where we curate the most consequential
        reporting in real time.
      </p>

      <CategoryIndexClient categories={categories} streams={categoryStreams} />
    </div>
  );
}
