'use client'

import { useEffect, useState, useCallback } from 'react'

// Full-screen photo viewer: arrows / swipe-free keyboard navigation through a
// set of photos, Esc or backdrop click to close. Used by the Action Items
// Online Scheduling tab and the scheduler lead detail page.
export default function PhotoLightbox({
  photos,
  startIndex = 0,
  onClose,
}: {
  photos: string[]
  startIndex?: number
  onClose: () => void
}) {
  const [index, setIndex] = useState(startIndex)

  const prev = useCallback(() => setIndex(i => (i - 1 + photos.length) % photos.length), [photos.length])
  const next = useCallback(() => setIndex(i => (i + 1) % photos.length), [photos.length])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') prev()
      else if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, prev, next])

  if (photos.length === 0) return null
  const url = photos[index]

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Close */}
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-5 text-white/80 hover:text-white text-3xl leading-none"
      >
        ×
      </button>

      {/* Counter + open-original */}
      <div className="absolute top-5 left-5 flex items-center gap-3 text-sm text-white/80" onClick={e => e.stopPropagation()}>
        <span>{index + 1} / {photos.length}</span>
        <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-white">
          Open full size
        </a>
      </div>

      {/* Prev / Next */}
      {photos.length > 1 && (
        <>
          <button
            onClick={e => { e.stopPropagation(); prev() }}
            aria-label="Previous photo"
            className="absolute left-3 md:left-6 text-white/70 hover:text-white text-5xl select-none px-3 py-6"
          >
            ‹
          </button>
          <button
            onClick={e => { e.stopPropagation(); next() }}
            aria-label="Next photo"
            className="absolute right-3 md:right-6 text-white/70 hover:text-white text-5xl select-none px-3 py-6"
          >
            ›
          </button>
        </>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={`Photo ${index + 1} of ${photos.length}`}
        className="max-h-[85vh] max-w-[90vw] object-contain rounded shadow-2xl"
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}
