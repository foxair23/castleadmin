// Streamed instantly while the server validates the widget key and loads
// settings — the visitor sees the widget frame immediately instead of a blank
// iframe for the duration of cold start + data fetch.
export default function SchedulerLoading() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '1.5rem', maxWidth: 560, margin: '0 auto' }}>
      <style>{`@keyframes castle-pulse { 0%,100% { opacity: .45 } 50% { opacity: .9 } }`}</style>
      {[
        { height: 28, width: '60%', marginBottom: 18 },
        { height: 44, width: '100%', marginBottom: 12 },
        { height: 44, width: '100%', marginBottom: 12 },
        { height: 44, width: '82%', marginBottom: 24 },
        { height: 48, width: '40%', marginBottom: 0 },
      ].map((s, i) => (
        <div
          key={i}
          style={{
            height: s.height,
            width: s.width,
            marginBottom: s.marginBottom,
            borderRadius: 8,
            background: '#e5e7eb',
            animation: 'castle-pulse 1.4s ease-in-out infinite',
            animationDelay: `${i * 120}ms`,
          }}
        />
      ))}
    </div>
  )
}
