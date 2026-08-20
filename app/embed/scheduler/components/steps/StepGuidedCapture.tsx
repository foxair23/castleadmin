'use client';

import { useMemo, useRef, useState } from 'react';
import { EstimateMedia, FlowState } from '../../lib/types';
import { getGuidedShots, ONLINE_ESTIMATE_DISCLAIMER } from '../../lib/online-estimate';

interface Props {
  state: FlowState;
  widgetKey: string;
  onNext: (partial: Partial<FlowState>) => void;
}

// PUT a file straight to its Supabase signed upload URL (XHR for progress).
function putWithProgress(url: string, file: File, mime: string, onProgress: (pct: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mime);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

export default function StepGuidedCapture({ state, widgetKey, onNext }: Props) {
  const shots = useMemo(() => getGuidedShots(state), [state]);
  const [media, setMedia] = useState<EstimateMedia[]>(state.estimate_media);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const mediaFor = (slot: string) => media.find((m) => m.slot === slot) ?? null;
  const filledCount = shots.filter((s) => mediaFor(s.slot)).length;

  async function uploadForSlot(slot: string, kind: 'photo' | 'video', file: File) {
    setError(null);
    if (!state.partial_lead_id) {
      setError("We couldn't attach your files — please go back a step and try again.");
      return;
    }
    setBusySlot(slot);
    setProgress(0);
    try {
      const signRes = await fetch('/api/scheduler/uploads/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Castle-Widget-Key': widgetKey },
        body: JSON.stringify({ lead_id: state.partial_lead_id, files: [{ name: file.name, type: file.type, size: file.size }] }),
      });
      const signData = await signRes.json().catch(() => ({})) as {
        files?: { name: string; path: string; uploadUrl: string; mime: string }[]; error?: string;
      };
      if (!signRes.ok || !signData.files?.[0]) {
        setError(signData.error || 'Upload failed — please try again.');
        return;
      }
      const target = signData.files[0];
      const ok = await putWithProgress(target.uploadUrl, file, target.mime, setProgress);
      if (!ok) { setError('Upload failed — please check your connection and try again.'); return; }

      const completeRes = await fetch('/api/scheduler/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Castle-Widget-Key': widgetKey },
        body: JSON.stringify({ lead_id: state.partial_lead_id, path: target.path, filename: file.name, mime: target.mime, size: file.size }),
      });
      if (!completeRes.ok) { setError("That file couldn't be saved — please try again."); return; }
      const data = await completeRes.json() as { url?: string };
      const entry: EstimateMedia = { slot, kind, path: target.path, url: data.url ?? '', filename: file.name };
      // One media item per slot — replace if re-captured.
      setMedia((prev) => [...prev.filter((m) => m.slot !== slot), entry]);
    } catch {
      setError('Upload failed — please check your connection and try again.');
    } finally {
      setBusySlot(null);
      setProgress(0);
      const el = inputRefs.current[slot];
      if (el) el.value = '';
    }
  }

  function removeSlot(slot: string) {
    setMedia((prev) => prev.filter((m) => m.slot !== slot));
  }

  const meterText =
    filledCount === 0
      ? 'Add at least one photo for a rough quote — the more you show us, the more exact your estimate.'
      : filledCount < shots.length
        ? `${filledCount} of ${shots.length} — enough for a ballpark; add the rest for an exact quote.`
        : `All ${shots.length} added — this gives us the most accurate quote. Thank you!`;

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-text)', margin: '0 0 0.375rem' }}>
        Show us your garage
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1rem', fontSize: '0.95rem' }}>
        Snap these with your phone — tap a card to open your camera. Every photo is optional, but more detail means a more accurate estimate.
      </p>

      {/* Quality meter */}
      <div style={{ marginBottom: '1.25rem' }}>
        <div style={{ height: '8px', borderRadius: '4px', background: 'var(--color-border)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.round((filledCount / shots.length) * 100)}%`, background: 'var(--color-primary)', transition: 'width 0.25s ease' }} />
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginTop: '0.4rem' }}>{meterText}</p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {shots.map((shot) => {
          const m = mediaFor(shot.slot);
          const isBusy = busySlot === shot.slot;
          const accept = shot.kind === 'video' ? 'video/*' : 'image/*';
          return (
            <div
              key={shot.slot}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.75rem 1rem',
                backgroundColor: m ? '#F0FDF4' : 'var(--color-white)',
                border: `2px solid ${m ? '#16A34A' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-card)',
              }}
            >
              {/* Thumbnail / icon */}
              <div style={{ width: '56px', height: '56px', borderRadius: 'var(--radius-input)', overflow: 'hidden', flexShrink: 0, background: 'var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {m && shot.kind === 'photo' && m.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt={shot.label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : m && shot.kind === 'video' ? (
                  <span style={{ fontSize: '1.5rem' }} aria-hidden="true">🎬</span>
                ) : (
                  <span style={{ fontSize: '1.5rem' }} aria-hidden="true">{shot.kind === 'video' ? '📹' : '📷'}</span>
                )}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: '0.9rem', color: 'var(--color-text)', margin: 0 }}>
                  {shot.label}
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', margin: '0.15rem 0 0' }}>{shot.hint}</p>
                {isBusy && (
                  <div style={{ marginTop: '0.4rem', height: '5px', borderRadius: '3px', background: 'var(--color-border)', overflow: 'hidden', maxWidth: '160px' }}>
                    <div style={{ height: '100%', width: `${progress}%`, background: 'var(--color-primary)', transition: 'width 0.2s ease' }} />
                  </div>
                )}
              </div>

              <input
                ref={(el) => { inputRefs.current[shot.slot] = el; }}
                type="file"
                accept={accept}
                capture="environment"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadForSlot(shot.slot, shot.kind, f); }}
                style={{ display: 'none' }}
              />
              {m ? (
                <button
                  type="button"
                  onClick={() => removeSlot(shot.slot)}
                  disabled={isBusy}
                  style={{ flexShrink: 0, padding: '0.5rem 0.75rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)', textDecoration: 'underline', cursor: 'pointer', fontSize: '0.85rem', minHeight: '44px' }}
                >
                  Retake
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => inputRefs.current[shot.slot]?.click()}
                  disabled={isBusy}
                  style={{ flexShrink: 0, padding: '0.5rem 0.875rem', background: 'var(--color-white)', border: '1.5px solid var(--color-primary)', color: 'var(--color-primary)', borderRadius: 'var(--radius-input)', cursor: isBusy ? 'wait' : 'pointer', fontSize: '0.85rem', fontWeight: 600, minHeight: '44px' }}
                >
                  {isBusy ? '…' : shot.kind === 'video' ? 'Record' : 'Add'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && (
        <p style={{ fontSize: '0.85rem', color: 'var(--color-primary)', marginBottom: '1rem' }}>{error}</p>
      )}

      <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        {ONLINE_ESTIMATE_DISCLAIMER}
      </p>

      <button
        type="button"
        onClick={() => onNext({ estimate_media: media })}
        disabled={busySlot !== null}
        style={{
          width: '100%', backgroundColor: 'var(--color-primary)', color: '#fff', fontFamily: 'var(--font-heading)',
          fontWeight: 600, fontSize: '1rem', padding: '0.875rem 1.5rem', borderRadius: 'var(--radius-input)',
          border: 'none', cursor: busySlot !== null ? 'wait' : 'pointer', minHeight: '44px',
        }}
      >
        Continue
      </button>
    </div>
  );
}
