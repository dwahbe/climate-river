"use client";

import { useState } from "react";

type PublisherIconProps = {
  domain: string;
  name: string;
  size?: number;
};

/**
 * Circular publisher favicon with fallback to initials
 * Uses Google's favicon service for reliable icon fetching
 */
export default function PublisherIcon({
  domain,
  name,
  size = 40,
}: PublisherIconProps) {
  const [hasError, setHasError] = useState(false);

  // Get first letter(s) for fallback
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  // Google favicon service - reliable and fast
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

  if (hasError || !domain) {
    return (
      <div
        className="flex items-center justify-center rounded-full bg-gradient-to-br from-zinc-100 to-zinc-200 text-zinc-600 font-semibold text-sm"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {initials || "?"}
      </div>
    );
  }

  return (
    <div
      className="relative rounded-full overflow-hidden bg-zinc-100 ring-1 ring-zinc-200/50"
      style={{ width: size, height: size }}
    >
      <img
        src={faviconUrl}
        alt=""
        width={size}
        height={size}
        className="w-full h-full object-cover"
        onError={() => setHasError(true)}
        loading="lazy"
      />
    </div>
  );
}
