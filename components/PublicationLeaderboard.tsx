"use client";

import { ChevronUp, ChevronDown, Minus } from "lucide-react";
import PublisherIcon from "@/components/PublisherIcon";
import type { LeaderboardEntry } from "@/lib/repositories/leaderboardRepository";

type Props = {
  entries: LeaderboardEntry[];
};

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function RankChange({ change }: { change: number | null }) {
  if (change === null) {
    return (
      <span className="text-[10px] font-medium text-blue-500" title="New">
        NEW
      </span>
    );
  }

  if (change > 0) {
    return (
      <span
        className="flex items-center text-emerald-600"
        title={`Up ${change}`}
      >
        <ChevronUp className="h-3.5 w-3.5" />
        <span className="text-[10px] font-medium tabular-nums">{change}</span>
      </span>
    );
  }

  if (change < 0) {
    return (
      <span
        className="flex items-center text-red-500"
        title={`Down ${Math.abs(change)}`}
      >
        <ChevronDown className="h-3.5 w-3.5" />
        <span className="text-[10px] font-medium tabular-nums">
          {Math.abs(change)}
        </span>
      </span>
    );
  }

  return (
    <span className="text-zinc-300" title="No change">
      <Minus className="h-3 w-3" />
    </span>
  );
}

export default function PublicationLeaderboard({ entries }: Props) {
  if (entries.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200/80 bg-white divide-y divide-zinc-200/80">
      {entries.map((entry, i) => (
        <a
          key={entry.homepage}
          href={entry.homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors"
        >
          <span className="text-xs font-medium text-zinc-400 w-5 text-right tabular-nums shrink-0">
            {i + 1}
          </span>

          <PublisherIcon
            domain={extractDomain(entry.homepage)}
            name={entry.name}
            size={28}
          />

          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-zinc-900 group-hover:text-zinc-700 truncate block">
              {entry.name}
            </span>
            <span className="text-xs text-zinc-500">
              {entry.leads} impact · {entry.articles}{" "}
              {entry.articles === 1 ? "story" : "stories"}
            </span>
          </div>

          <div className="shrink-0 w-8 flex justify-center">
            <RankChange change={entry.change} />
          </div>
        </a>
      ))}
    </div>
  );
}
