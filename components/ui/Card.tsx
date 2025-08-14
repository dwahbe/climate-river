// components/ui/Card.tsx
'use client'
import clsx from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'

export default function Card({
  as: As = 'section',
  className,
  children,
  ...props
}: {
  as?: any
  className?: string
  children: ReactNode
} & HTMLAttributes<HTMLElement>) {
  return (
    <As
      {...props}
      className={clsx(
        'rounded-2xl border border-zinc-200/80 bg-white',
        'shadow-[0_1px_0_rgba(0,0,0,0.05)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.07)]',
        'transition-shadow',
        'p-4 sm:p-5 md:p-6',
        className
      )}
    >
      {children}
    </As>
  )
}
