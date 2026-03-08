"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
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
    flushSync(() => setDesktopOpen(true));
    desktopInputRef.current?.focus();
  }, []);

  const collapseDesktop = useCallback(() => {
    setDesktopOpen(false);
  }, []);

  function navigate(q: string) {
    setDesktopOpen(false);
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

      {/* Desktop: pill / inline input */}
      <div className="hidden md:block w-48 h-8">
        {desktopOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const q = desktopInputRef.current?.value.trim();
              if (q) navigate(q);
            }}
            className="h-full"
          >
            <div
              className="h-full rounded-lg p-[1.5px] animate-[gradient-spin_3s_linear_infinite]"
              style={{
                background:
                  "conic-gradient(from var(--border-angle), #3B82F6, #EC4899, #06B6D4, #EF4444, #10B981, #8B5CF6, #3B82F6)",
              }}
            >
              <div className="relative h-full flex items-center rounded-[calc(0.5rem-1.5px)] bg-white">
                <SearchIcon className="absolute left-2.5 h-3.5 w-3.5 text-zinc-400 pointer-events-none" />
                <input
                  ref={desktopInputRef}
                  type="search"
                  placeholder="Find..."
                  autoComplete="off"
                  onBlur={collapseDesktop}
                  className="h-full w-full rounded-[calc(0.5rem-1.5px)] bg-transparent py-0 pl-8 pr-10 text-sm placeholder:text-zinc-400 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
                />
                <kbd className="absolute right-2 text-[10px] leading-none text-zinc-400 border border-zinc-200 rounded px-1 py-0.5 font-sans pointer-events-none">
                  Esc
                </kbd>
              </div>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={expandDesktop}
            className="h-full w-full flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 text-sm text-zinc-400 hover:border-zinc-300 hover:text-zinc-500 transition-colors cursor-pointer"
            aria-label="Search"
          >
            <SearchIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left">Find...</span>
            <kbd className="text-[10px] leading-none border border-zinc-200 rounded px-1 py-0.5 font-sans">
              F
            </kbd>
          </button>
        )}
      </div>
    </>
  );
}
