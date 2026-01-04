"use client";

import { useEffect, useMemo, useReducer } from "react";

const fullFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Los_Angeles",
});

const dateOnlyFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/Los_Angeles",
});

function getRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return "now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  } else if (diffHours < 24) {
    return `${diffHours}h`;
  } else if (diffDays < 7) {
    return `${diffDays}d`;
  } else {
    return dateOnlyFormatter.format(date);
  }
}

export default function LocalTime({ iso }: { iso: string }) {
  const date = useMemo(() => new Date(iso), [iso]);
  const fullTime = `${fullFormatter.format(date)} PT`;

  // Force re-renders for relative time updates
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    // Update every minute for fresh relative times
    const interval = setInterval(forceUpdate, 60000);
    return () => clearInterval(interval);
  }, []);

  // Compute relative time on each render
  const relativeTime = getRelativeTime(date);

  // Suppress hydration mismatch by using suppressHydrationWarning
  return (
    <time dateTime={iso} title={fullTime} suppressHydrationWarning>
      {relativeTime}
    </time>
  );
}
