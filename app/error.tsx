"use client";

import Link from "next/link";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <h1 className="text-4xl font-bold text-zinc-900 mb-4">
        Something went wrong
      </h1>
      <p className="text-zinc-600 mb-8">
        We&apos;re having trouble loading this page.
      </p>
      <div className="flex gap-4">
        <button
          onClick={reset}
          className="px-6 py-3 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 text-sm"
        >
          Try again
        </button>
        <Link
          href="/"
          className="px-6 py-3 border border-zinc-300 text-zinc-700 rounded-lg hover:bg-zinc-50 text-sm no-underline"
        >
          Return home
        </Link>
      </div>
    </div>
  );
}
