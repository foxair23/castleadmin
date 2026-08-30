// Instant skeleton while the server loads HD Orders (orders + SF-job matching +
// attachments). Streams immediately so navigation never shows a frozen page; covers
// this segment and the nested /clopay and /clopay-sts tabs.
export default function Loading() {
  return (
    <div className="max-w-7xl mx-auto px-4 py-6 animate-pulse">
      <div className="h-9 w-72 bg-gray-200 rounded mb-6" />
      <div className="h-8 w-64 bg-gray-200 rounded mb-4" />
      <div className="h-10 w-full bg-gray-100 rounded mb-4" />
      <div className="flex gap-2 mb-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-7 w-24 bg-gray-100 rounded-full" />)}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 12 }).map((_, i) => <div key={i} className="h-9 w-full bg-gray-100 rounded" />)}
      </div>
    </div>
  )
}
