import type { LucideIcon } from 'lucide-react'
import {
  Landmark,
  Megaphone,
  Factory,
  AlertTriangle,
  Zap,
  Microscope,
} from 'lucide-react'
import type { CategorySlug } from '@/lib/tagger'

export const CATEGORY_ICON_MAP: Record<CategorySlug, LucideIcon> = {
  government: Landmark,
  justice: Megaphone,
  business: Factory,
  impacts: AlertTriangle,
  tech: Zap,
  research: Microscope,
} as const

export function CategoryIcon({
  slug,
  className,
  strokeWidth = 1.75,
}: {
  slug: CategorySlug
  className?: string
  strokeWidth?: number
}) {
  const Icon = CATEGORY_ICON_MAP[slug]
  return (
    <Icon className={className} strokeWidth={strokeWidth} aria-hidden="true" />
  )
}
