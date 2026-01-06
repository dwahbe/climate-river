"use client";

import { useState } from "react";

type ArticleImageProps = {
  src: string;
  href: string;
  ping?: string;
};

export default function ArticleImage({ src, href, ping }: ArticleImageProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return null;
  }

  return (
    <a href={href} ping={ping} className="block mb-3">
      <div className="relative aspect-[2/1] rounded-xl overflow-hidden bg-zinc-100">
        <img
          src={src}
          alt=""
          loading="lazy"
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setHasError(true)}
        />
      </div>
    </a>
  );
}
