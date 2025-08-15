'use client'

type Props = {
  href: string
  children: React.ReactNode
  className?: string
}

export default function PublisherLink({ href, children, className }: Props) {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    // Force navigation in same tab
    window.location.href = href
  }

  return (
    <a
      href={href}
      className={className}
      onClick={handleClick}
      target="_self"
      rel="noopener"
    >
      {children}
    </a>
  )
}
