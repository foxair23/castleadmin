export const dynamic = 'force-dynamic'

function prettyDate(dateStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}
function windowLabel(start?: string, end?: string): string {
  const fmt = (t?: string) => {
    if (!t || !/^\d{2}:\d{2}$/.test(t)) return ''
    const [h, m] = t.split(':').map(Number)
    const ampm = h < 12 ? 'AM' : 'PM'
    const h12 = h % 12 === 0 ? 12 : h % 12
    return m ? `${h12}:${String(m).padStart(2, '0')} ${ampm}` : `${h12} ${ampm}`
  }
  return `${fmt(start)} – ${fmt(end)}`
}

export default async function GenieConfirmation({ searchParams }: { searchParams: Promise<{ order?: string; date?: string; ws?: string; we?: string; phone?: string }> }) {
  const { order, date, ws, we, phone } = await searchParams
  return (
    <div style={{ fontFamily: 'var(--font-body)', background: 'var(--color-bg)', minHeight: '100%', padding: '2rem 0.75rem' }}>
      <div style={{ background: 'var(--color-white)', borderRadius: 'var(--radius-large)', boxShadow: 'var(--shadow-card)', padding: '1.5rem', margin: '0 auto', maxWidth: 480, textAlign: 'center' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#F0FDF4', border: '2px solid #86EFAC', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem', color: '#16A34A', fontSize: 28 }}>✓</div>
        <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.35rem', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 0.35rem' }}>You’re scheduled!</h2>
        <p style={{ color: 'var(--color-text-muted)', margin: '0 0 1rem' }}>We’ve got your Genie installation on the calendar. Our tech will call ahead before arriving.</p>
        <div style={{ textAlign: 'left', background: 'var(--color-bg)', borderRadius: 'var(--radius-input)', padding: '0.9rem 1rem', margin: '0 0 1rem' }}>
          {order && <Row label="Order" value={`#${order}`} />}
          {date && <Row label="Date" value={prettyDate(date)} />}
          {(ws || we) && <Row label="Arrival window" value={windowLabel(ws, we)} />}
        </div>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem', margin: 0 }}>
          Need to change something? Call us at{' '}
          <a href={`tel:${phone ?? ''}`} style={{ color: 'var(--color-primary)', fontWeight: 700 }}>{phone ?? 'our office'}</a>.
        </p>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.25rem 0', fontSize: '0.95rem' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span style={{ color: 'var(--color-text)', fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  )
}
