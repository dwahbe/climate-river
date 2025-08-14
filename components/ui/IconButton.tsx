'use client'
import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export default function IconButton({
  className,
  children,
  ...props
}: {
  className?: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        'inline-flex items-center justify-center',
        'h-9 w-9 rounded-full',
        'text-zinc-600 hover:text-zinc-900',
        'hover:bg-zinc-100/70 active:bg-zinc-200/60',
        'transition-colors focus-visible:focus-ring',
        className
      )}
    >
      {children}
    </button>
  )
}
