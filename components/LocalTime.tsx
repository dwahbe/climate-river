'use client'
import { useMemo } from 'react'

export default function LocalTime({ iso }: { iso: string }) {
  const d = useMemo(() => new Date(iso), [iso])
  const pretty = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(d),
    [d]
  )
  return (
    <time dateTime={iso} title={iso}>
      {pretty}
    </time>
  )
}
