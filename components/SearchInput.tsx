"use client";

import { useRef, useEffect } from "react";

export default function SearchInput({
  defaultValue = "",
}: {
  defaultValue?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form action="/search" className="mb-6">
      <div className="relative">
        <svg
          className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-400 pointer-events-none"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
        <input
          ref={inputRef}
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder="Search climate news..."
          autoComplete="off"
          className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 pl-11 text-base placeholder:text-zinc-400 focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-100 transition-shadow"
        />
      </div>
    </form>
  );
}
