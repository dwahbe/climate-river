import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-4 text-center">
      <h1 className="text-6xl font-bold text-zinc-900 mb-4">404</h1>
      <p className="text-xl text-zinc-600 mb-8">This page could not be found</p>
      <Link
        href="/"
        className="px-6 py-3 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors no-underline"
      >
        Return Home
      </Link>
    </div>
  );
}
