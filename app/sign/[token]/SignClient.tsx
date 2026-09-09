'use client'

import { useEffect, useRef, useState } from 'react'
import type { SignScope, SignState } from '@/lib/esign/transitions'

// The signing screen: the form to read, a typed name, a consent box, and a hand-drawn
// signature on a canvas pad. Works with a finger on a phone (pointer events, no scroll
// while drawing). The PNG sent up is cropped to the ink so it fills the form's signature
// line rather than shrinking to fit an empty canvas.

interface Input { key: string; label: string; required: boolean }

const fmtPt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'long', timeStyle: 'short' })

export default function SignClient({ token, scope, state, service, pdfUrl, customerName, address, jobNumber, inputs, signedName, signedAt, customerSignedAt }: {
  token: string; scope: SignScope; state: SignState; service: 'install' | 'delivery'; pdfUrl: string | null
  customerName: string | null; address: string | null; jobNumber: string | null; inputs: Input[]
  signedName: string | null; signedAt: string | null; customerSignedAt: string | null
}) {
  const [name, setName] = useState('')
  const [agree, setAgree] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [hasInk, setHasInk] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ name: string; at: string } | null>(signedAt && signedName ? { name: signedName, at: signedAt } : null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  const formName = service === 'delivery' ? 'Home Depot proof-of-delivery form' : 'Home Depot completion form'
  const work = service === 'delivery' ? 'delivery' : 'installation'

  // Size the canvas to its box at device resolution, once.
  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = c.clientWidth, h = c.clientHeight
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr)
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111'
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; last.current = pos(e) }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    e.preventDefault()
    const ctx = e.currentTarget.getContext('2d')!
    const p = pos(e)
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke()
    last.current = p
    if (!hasInk) setHasInk(true)
  }
  const up = () => { drawing.current = false; last.current = null }
  const clear = () => {
    const c = canvasRef.current; if (!c) return
    const ctx = c.getContext('2d')!
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.restore()
    setHasInk(false)
  }
  /** The ink's bounding box, padded, as a PNG data URL — or null when the pad is empty. */
  const exportInk = (): string | null => {
    const c = canvasRef.current; if (!c) return null
    const ctx = c.getContext('2d')!
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
    let minX = width, minY = height, maxX = -1, maxY = -1
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    }
    if (maxX < 0) return null
    const pad = 6
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad)
    const out = document.createElement('canvas')
    out.width = maxX - minX + 1; out.height = maxY - minY + 1
    out.getContext('2d')!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  }

  const missing = inputs.filter(i => i.required && !(fields[i.key] ?? '').trim())
  const canSubmit = agree && name.trim().length > 1 && hasInk && missing.length === 0 && !submitting

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true); setError('')
    try {
      const png = exportInk()
      if (!png) throw new Error('Please draw your signature.')
      const res = await fetch(`/api/sign/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ typed_name: name.trim(), agree: true, signature_png: png, fields }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not save your signature.')
      setDone({ name: name.trim(), at: data.signed_at })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your signature.')
      setSubmitting(false)
    }
  }

  const card = 'bg-white rounded-xl shadow-sm border border-gray-200 p-5'

  const body = (() => {
    if (done) return (
      <div className={card}>
        <h2 className="text-lg font-semibold text-gray-900">Thank you — your signature is recorded.</h2>
        <p className="mt-2 text-sm text-gray-700">Signed by <strong>{done.name}</strong> on {fmtPt(done.at)} (Pacific).</p>
        {scope === 'customer' && <p className="mt-2 text-sm text-gray-700">Your technician will add their signature next. You&rsquo;ll receive a copy of the completed form by email.</p>}
        {scope === 'tech' && <p className="mt-2 text-sm text-gray-700">The completed form will be filed on the job automatically.</p>}
      </div>)
    if (state === 'cancelled') return <div className={card}><p className="text-sm text-gray-700">This form is no longer needed. Nothing to do.</p></div>
    if (state === 'waiting_customer') return <div className={card}><p className="text-sm text-gray-700">The customer hasn&rsquo;t signed yet. You&rsquo;ll get a text as soon as they do — come back to this link then.</p></div>
    if (state === 'not_ready' || !pdfUrl) return <div className={card}><p className="text-sm text-gray-700">This form isn&rsquo;t ready to sign yet. Please try again later, or call us at (800) 576-1397.</p></div>
    return (
      <>
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-900">1. Review the form</h2>
          {scope === 'customer' && <p className="mt-1 text-sm text-gray-700">Please sign only once your {work} is complete.</p>}
          {scope === 'tech' && customerSignedAt && <p className="mt-1 text-sm text-gray-700">Customer signed {fmtPt(customerSignedAt)}.</p>}
          <div className="mt-3 rounded-lg border border-gray-200 overflow-hidden bg-gray-100">
            <iframe title="Form" src={`${pdfUrl}#toolbar=0&navpanes=0`} className="w-full h-[60vh] min-h-[420px] bg-white" />
          </div>
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-sm text-red-700 underline">Open the PDF in a new tab</a>
        </div>
        {inputs.length > 0 && (
          <div className={card}>
            <h2 className="text-base font-semibold text-gray-900">2. A few details</h2>
            {inputs.map(i => (
              <label key={i.key} className="block mt-3 text-sm text-gray-700">{i.label}{i.required ? ' *' : ''}
                <input className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-gray-900" value={fields[i.key] ?? ''} onChange={e => setFields({ ...fields, [i.key]: e.target.value })} />
              </label>))}
          </div>)}
        <div className={card}>
          <h2 className="text-base font-semibold text-gray-900">{inputs.length ? '3' : '2'}. Sign</h2>
          <label className="block mt-3 text-sm text-gray-700">Your full name *
            <input className="mt-1 w-full border border-gray-300 rounded px-3 py-2 text-gray-900" value={name} onChange={e => setName(e.target.value)} placeholder="Type your full name" autoComplete="name" />
          </label>
          <div className="mt-3 text-sm text-gray-700">Draw your signature *</div>
          <div className="mt-1 relative rounded-lg border-2 border-dashed border-gray-300 bg-white">
            <canvas ref={canvasRef} className="w-full h-44 touch-none select-none block" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
            <div className="absolute left-4 right-4 bottom-8 border-b border-gray-300 pointer-events-none" />
            {!hasInk && <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">Sign here with your finger or mouse</div>}
          </div>
          <div className="mt-1 flex justify-end"><button type="button" className="text-xs text-gray-600 underline" onClick={clear}>Clear</button></div>
          <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-1 text-gray-900" checked={agree} onChange={e => setAgree(e.target.checked)} />
            <span>I have reviewed the {formName} above and agree that my electronic signature is the legal equivalent of my handwritten signature.</span>
          </label>
          {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
          <button type="button" disabled={!canSubmit} onClick={submit} className="mt-4 w-full rounded-lg bg-red-700 px-4 py-3 text-white font-semibold disabled:opacity-40">
            {submitting ? 'Saving…' : 'Sign and submit'}
          </button>
        </div>
      </>)
  })()

  return (
    <div className="min-h-screen bg-gray-50 py-6 px-4">
      <div className="max-w-xl mx-auto space-y-4">
        <div className="text-center">
          <div className="text-xs font-semibold tracking-wide text-red-700">CASTLE GARAGE DOORS &amp; GATES</div>
          <h1 className="mt-1 text-xl font-semibold text-gray-900">{scope === 'tech' ? 'Technician signature' : formName.replace('Home Depot ', 'Home Depot ')}</h1>
          {(customerName || address) && <p className="mt-1 text-sm text-gray-600">{[customerName, address].filter(Boolean).join(' · ')}{jobNumber ? ` · Job ${jobNumber}` : ''}</p>}
        </div>
        {body}
        <p className="text-center text-xs text-gray-500">Questions? Call (800) 576-1397.</p>
      </div>
    </div>
  )
}
