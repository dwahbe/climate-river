"use client";

import Link from "next/link";
import { CategoryIcon } from "@/components/categoryIcons";
import type { CategorySlug } from "@/lib/tagger";

export type CategoryInfo = {
  slug: CategorySlug;
  name: string;
  description: string;
  color: string;
};

type ChipSlug = CategorySlug | "all";

type CategoryChipsProps = {
  mode: "filter" | "nav";
  categories: CategoryInfo[];
  selectedSlug: ChipSlug;
  onSelect?: (slug: ChipSlug) => void;
  includeAll?: boolean;
  className?: string;
};

function getReadableTextColor(hexColor: string) {
  const normalized = hexColor.replace("#", "");
  if (normalized.length !== 6) {
    return "#111111";
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  return luminance > 0.62 ? "#111111" : "#FFFFFF";
}

function getIconStyle(color: string, isActive: boolean) {
  if (!color) {
    return undefined;
  }

  if (!isActive) {
    return { color };
  }

  return {
    color: getReadableTextColor(color),
  };
}

function getActiveChipStyle(color: string) {
  if (!color) {
    return undefined;
  }

  const textColor = getReadableTextColor(color);

  return {
    backgroundColor: color,
    borderColor: color,
    color: textColor,
  };
}

export default function CategoryChips({
  mode,
  categories,
  selectedSlug,
  onSelect,
  includeAll = true,
  className = "",
}: CategoryChipsProps) {
  const chips = [
    ...(includeAll ? [{ slug: "all" as const, name: "All", color: "" }] : []),
    ...categories.map((category) => ({
      slug: category.slug,
      name: category.name,
      color: category.color,
    })),
  ];

  return (
    <div
      className={`flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 ${className}`}
      role="list"
    >
      {chips.map((chip) => {
        const isActive = selectedSlug === chip.slug;
        const isAllChip = chip.slug === "all";
        const iconStyle = getIconStyle(chip.color, isActive);
        const chipClass = `inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ${isActive ? (isAllChip ? "bg-zinc-900 text-white border-zinc-900" : "text-white") : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50"}`;
        const activeChipStyle =
          isActive && !isAllChip ? getActiveChipStyle(chip.color) : undefined;

        if (mode === "filter") {
          return (
            <button
              key={chip.slug}
              type="button"
              className={chipClass}
              style={activeChipStyle}
              onClick={() => onSelect?.(chip.slug)}
            >
              {chip.slug !== "all" && (
                <CategoryIcon
                  slug={chip.slug}
                  className="h-3.5 w-3.5"
                  style={iconStyle}
                />
              )}
              <span>{chip.name}</span>
            </button>
          );
        }

        const href =
          chip.slug === "all" ? "/categories" : `/categories/${chip.slug}`;

        return (
          <Link
            key={chip.slug}
            href={href}
            className={chipClass}
            style={activeChipStyle}
          >
            {chip.slug !== "all" && (
              <CategoryIcon
                slug={chip.slug}
                className="h-3.5 w-3.5"
                style={iconStyle}
              />
            )}
            <span>{chip.name}</span>
          </Link>
        );
      })}
    </div>
  );
}
