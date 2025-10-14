'use client'

import {
  type CSSProperties,
  type PointerEvent,
  useCallback,
  useRef,
} from 'react'
import clsx from 'clsx'

import ClimateRiverLogo from './ClimateRiverLogo'

type HeaderLogoHoverProps = {
  className?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const SIZE_MAP: Record<NonNullable<HeaderLogoHoverProps['size']>, string> = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8',
  xl: 'h-12 w-12',
}

const clampPercentage = (value: number) => {
  if (Number.isNaN(value)) return 50
  return Math.min(100, Math.max(0, value))
}

const LOGO_MASK =
  'radial-gradient(circle at var(--pointer-x, 50%) var(--pointer-y, 50%), black var(--logo-reveal-inner), transparent var(--logo-reveal-outer))'

export default function HeaderLogoHover({
  className,
  size = 'lg',
}: HeaderLogoHoverProps) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const overlayRef = useRef<HTMLSpanElement>(null)
  const containerRectRef = useRef<DOMRect | null>(null)

  const measureContainer = useCallback(() => {
    const container = containerRef.current
    if (!container) {
      return null
    }

    const rect = container.getBoundingClientRect()
    containerRectRef.current = rect
    return rect
  }, [])

  const setActiveState = useCallback((value: boolean) => {
    const overlay = overlayRef.current
    if (!overlay) {
      return
    }

    overlay.dataset.active = value ? 'true' : 'false'
  }, [])

  const updatePointer = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const overlay = overlayRef.current

      if (!overlay) {
        return
      }

      const bounds = containerRectRef.current ?? measureContainer()

      if (!bounds) {
        return
      }

      const { left, top, width, height } = bounds
      if (width === 0 || height === 0) {
        return
      }
      const relativeX = ((event.clientX - left) / width) * 100
      const relativeY = ((event.clientY - top) / height) * 100

      overlay.style.setProperty('--pointer-x', `${clampPercentage(relativeX)}%`)
      overlay.style.setProperty('--pointer-y', `${clampPercentage(relativeY)}%`)
    },
    [measureContainer]
  )

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      setActiveState(true)
      containerRectRef.current = measureContainer()
      updatePointer(event)
    },
    [measureContainer, setActiveState, updatePointer]
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      updatePointer(event)
    },
    [updatePointer]
  )

  const handlePointerLeave = useCallback(() => {
    setActiveState(false)
    containerRectRef.current = null
  }, [setActiveState])

  return (
    <span
      ref={containerRef}
      aria-hidden="true"
      className={clsx(
        'relative inline-flex select-none items-center justify-center',
        SIZE_MAP[size],
        className
      )}
      onPointerDown={handlePointerEnter}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerLeave}
      onPointerLeave={handlePointerLeave}
    >
      <ClimateRiverLogo
        size={size}
        variant="monochrome"
        animated={false}
        className="block text-zinc-900"
      />

      <span
        ref={overlayRef}
        data-active="false"
        style={
          {
            '--pointer-x': '50%',
            '--pointer-y': '50%',
            maskImage: LOGO_MASK,
            WebkitMaskImage: LOGO_MASK,
          } as CSSProperties
        }
        className={clsx(
          'pointer-events-none absolute inset-0 inline-flex items-center justify-center',
          '[--logo-reveal-inner:0%] [--logo-reveal-outer:0%]',
          '[transition:--logo-reveal-inner_150ms_ease-out,--logo-reveal-outer_150ms_ease-out]',
          'data-[active=true]:[--logo-reveal-inner:30%] data-[active=true]:[--logo-reveal-outer:55%]',
          'group-focus-visible:[--logo-reveal-inner:110%] group-focus-visible:[--logo-reveal-outer:140%]'
        )}
      >
        <ClimateRiverLogo
          size={size}
          variant="colored"
          animated={false}
          className="block"
        />
      </span>
    </span>
  )
}
