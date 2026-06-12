"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

const SearchIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
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
);

function MobileSearch({
  open,
  onClose,
  onSearch,
}: {
  open: boolean;
  onClose: () => void;
  onSearch: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-white">
      <div className="px-4 pt-[calc(env(safe-area-inset-top)+12px)]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const q = inputRef.current?.value.trim();
            if (q) onSearch(q);
          }}
          className="flex items-center gap-3 py-3 border-b border-zinc-100"
        >
          <SearchIcon className="h-5 w-5 text-zinc-400 shrink-0" />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search climate news..."
            autoComplete="off"
            className="flex-1 text-base bg-transparent placeholder:text-zinc-400 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-sm font-medium text-zinc-500 hover:text-zinc-900 shrink-0"
          >
            Cancel
          </button>
        </form>
        <p className="text-sm text-zinc-400 text-center pt-16">
          Search across all climate news articles
        </p>
      </div>
    </div>
  );
}

export default function SearchLink() {
  const router = useRouter();
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const desktopInputRef = useRef<HTMLInputElement>(null);

  const expandDesktop = useCallback(() => {
    desktopInputRef.current?.focus();
  }, []);

  const collapseDesktop = useCallback(() => {
    desktopInputRef.current?.blur();
  }, []);

  function navigate(q: string) {
    if (desktopInputRef.current) desktopInputRef.current.value = "";
    desktopInputRef.current?.blur();
    setMobileOpen(false);
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (desktopOpen) collapseDesktop();
        if (mobileOpen) setMobileOpen(false);
        return;
      }

      if (
        e.key === "f" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const tag = (e.target as HTMLElement)?.tagName;
        const editable = (e.target as HTMLElement)?.isContentEditable;
        if (tag === "INPUT" || tag === "TEXTAREA" || editable) return;

        // Don't steal focus into the (hidden) search input while a modal
        // like the reader panel or sheet is open
        if (document.querySelector('[role="dialog"]')) return;

        e.preventDefault();
        expandDesktop();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [desktopOpen, mobileOpen, expandDesktop, collapseDesktop]);

  return (
    <>
      {/* Mobile: icon only */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="md:hidden self-center text-zinc-600 hover:text-zinc-900 cursor-pointer"
        aria-label="Search"
      >
        <SearchIcon className="h-[18px] w-[18px]" />
      </button>

      <MobileSearch
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onSearch={navigate}
      />

      {/* Desktop: always-rendered input; focus toggles the gradient border */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const q = desktopInputRef.current?.value.trim();
          if (q) navigate(q);
        }}
        className="hidden md:block w-48 h-8"
      >
        <div
          onClick={() => desktopInputRef.current?.focus()}
          className={`h-full w-full rounded-card p-[1.5px] transition-colors ${
            desktopOpen
              ? "animate-[gradient-spin_3s_linear_infinite]"
              : "bg-zinc-200 hover:bg-zinc-300"
          }`}
          style={
            desktopOpen
              ? {
                  background:
                    "conic-gradient(from var(--border-angle), var(--color-cat-government), var(--color-cat-activism), var(--color-cat-business), var(--color-cat-impacts), var(--color-cat-tech), var(--color-cat-research), var(--color-cat-government))",
                }
              : undefined
          }
        >
          <div className="relative h-full flex items-center rounded-[calc(var(--radius-card)-1.5px)] bg-white">
            <SearchIcon className="absolute left-2.5 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
            <input
              ref={desktopInputRef}
              type="text"
              placeholder="Find..."
              autoComplete="off"
              aria-label="Search"
              onFocus={() => setDesktopOpen(true)}
              onBlur={() => setDesktopOpen(false)}
              className="h-full w-full appearance-none rounded-[calc(var(--radius-card)-1.5px)] bg-transparent py-0 pl-8 pr-10 text-sm placeholder:text-zinc-400 focus:outline-none cursor-pointer focus:cursor-text"
            />
            <kbd className="absolute right-2 text-[10px] leading-none text-zinc-400 border border-zinc-200 rounded px-1 py-0.5 font-sans pointer-events-none">
              {desktopOpen ? "Esc" : "F"}
            </kbd>
          </div>
        </div>
      </form>
    </>
  );
}
