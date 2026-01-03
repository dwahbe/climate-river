"use client";

import { useState, useEffect } from "react";

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
  const [relativeTime, setRelativeTime] = useState<string>("");
  const date = new Date(iso);
  const fullTime = `${fullFormatter.format(date)} PT`;

  useEffect(() => {
    // Set initial relative time
    setRelativeTime(getRelativeTime(date));

    // Update every minute for fresh relative times
    const interval = setInterval(() => {
      setRelativeTime(getRelativeTime(date));
    }, 60000);

    return () => clearInterval(interval);
  }, [iso]);

  // Show placeholder on server, relative time on client
  if (!relativeTime) {
    return <time dateTime={iso}>{dateOnlyFormatter.format(date)}</time>;
  }

  return (
    <time dateTime={iso} title={fullTime}>
      {relativeTime}
    </time>
  );
}
