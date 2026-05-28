'use client';

import { useState, useRef } from 'react';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  widgetKey: string;
  onNext: (partial: Partial<FlowState>) => void;
}

export default function StepOptionalDetails({ state, widgetKey, onNext }: Props) {
  const [note, setNote] = useState(state.optional_note);
  const [photoUrls, setPhotoUrls] = useState<string[]>(state.uploaded_photo_urls);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleContinue() {
    onNext({ optional_note: note, uploaded_photo_urls: photoUrls });
  }

  function handleSkip() {
    onNext({ optional_note: '', uploaded_photo_urls: [] });
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (!state.partial_lead_id) return; // can't upload without a lead record
    setUploading(true);
    try {
      const newUrls: string[] = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append('files', file);
        formData.append('lead_id', state.partial_lead_id);
        const res = await fetch('/api/scheduler/uploads', {
          method: 'POST',
          headers: { 'X-Castle-Widget-Key': widgetKey },
          body: formData,
        });
        if (res.ok) {
          const data = await res.json() as { uploads: { url: string }[] };
          const url = data.uploads?.[0]?.url;
          if (url) newUrls.push(url);
        }
      }
      setPhotoUrls((prev) => [...prev, ...newUrls]);
    } catch {
      // non-blocking — ignore upload errors silently
    }
    setUploading(false);
    // reset input so same file can be reselected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removePhoto(index: number) {
    setPhotoUrls((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div>
      <h2
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: '1.5rem',
          fontWeight: 700,
          color: 'var(--color-text)',
          margin: '0 0 0.375rem',
        }}
      >
        Want to tell us more?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        This step is optional, but it can help our technicians prepare.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        <label
          htmlFor="optional-note"
          style={{
            display: 'block',
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: '0.875rem',
            color: 'var(--color-text)',
            marginBottom: '0.375rem',
          }}
        >
          Notes
        </label>
        <textarea
          id="optional-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="Anything else you'd like us to know?"
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            fontSize: '0.95rem',
            fontFamily: 'var(--font-body)',
            border: '1.5px solid var(--color-border)',
            borderRadius: 'var(--radius-input)',
            outline: 'none',
            resize: 'vertical',
            backgroundColor: 'var(--color-white)',
            color: 'var(--color-text)',
            boxSizing: 'border-box',
          }}
        />
        <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
          Examples: the door is stuck open, the opener is making noise...
        </p>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <p
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 600,
            fontSize: '0.875rem',
            color: 'var(--color-text)',
            marginBottom: '0.5rem',
          }}
        >
          Photos (optional)
        </p>

        {photoUrls.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.625rem',
              marginBottom: '0.75rem',
            }}
          >
            {photoUrls.map((url, i) => (
              <div
                key={i}
                style={{
                  position: 'relative',
                  width: '80px',
                  height: '80px',
                  borderRadius: 'var(--radius-input)',
                  overflow: 'hidden',
                  border: '1.5px solid var(--color-border)',
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Uploaded photo ${i + 1}`}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <button
                  type="button"
                  onClick={() => removePhoto(i)}
                  aria-label={`Remove photo ${i + 1}`}
                  style={{
                    position: 'absolute',
                    top: '2px',
                    right: '2px',
                    width: '22px',
                    height: '22px',
                    borderRadius: '50%',
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    color: '#fff',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.8rem',
                    lineHeight: 1,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          style={{ display: 'none' }}
          id="photo-upload"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.625rem 1rem',
            backgroundColor: 'var(--color-white)',
            border: '1.5px dashed var(--color-border)',
            borderRadius: 'var(--radius-input)',
            cursor: uploading ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font-body)',
            fontSize: '0.9rem',
            color: 'var(--color-text-muted)',
            minHeight: '44px',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          {uploading ? 'Uploading…' : 'Add photos'}
        </button>
      </div>

      <button
        type="button"
        onClick={handleContinue}
        style={{
          width: '100%',
          backgroundColor: 'var(--color-primary)',
          color: '#fff',
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: '1rem',
          padding: '0.875rem 1.5rem',
          borderRadius: 'var(--radius-input)',
          border: 'none',
          cursor: 'pointer',
          minHeight: '44px',
          transition: 'background-color 0.15s',
          marginBottom: '0.75rem',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary-hover)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--color-primary)';
        }}
      >
        Continue
      </button>

      <button
        type="button"
        onClick={handleSkip}
        style={{
          width: '100%',
          backgroundColor: 'transparent',
          color: 'var(--color-text-muted)',
          fontFamily: 'var(--font-body)',
          fontSize: '0.9rem',
          padding: '0.5rem',
          border: 'none',
          cursor: 'pointer',
          textDecoration: 'underline',
          minHeight: '44px',
        }}
      >
        Skip this step
      </button>
    </div>
  );
}
