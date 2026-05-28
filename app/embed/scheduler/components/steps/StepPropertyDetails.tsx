'use client';

import { useState, useEffect, useRef } from 'react';
import { FlowState } from '../../lib/types';

interface Props {
  state: FlowState;
  onNext: (partial: Partial<FlowState>) => void;
}

// Minimal type shim for the Google Maps Places API loaded via script tag.
declare global {
  interface Window {
    google?: {
      maps?: {
        places?: {
          Autocomplete: new (
            input: HTMLInputElement,
            opts?: object
          ) => {
            addListener: (event: string, handler: () => void) => void
            getPlace: () => {
              address_components?: { long_name: string; short_name: string; types: string[] }[]
            }
          }
        }
      }
    }
  }
}

function loadGoogleMapsScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.places) { resolve(); return }
    const existing = document.getElementById('castle-gmaps')
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.id = 'castle-gmaps'
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Maps script'))
    document.head.appendChild(script)
  })
}

export default function StepPropertyDetails({ state, onNext }: Props) {
  const [firstName, setFirstName] = useState(state.first_name);
  const [lastName, setLastName] = useState(state.customer_last_name);
  const [addressLine1, setAddressLine1] = useState(state.address_line1);
  const [city, setCity] = useState(state.address_city);
  const [stateAbbr, setStateAbbr] = useState(state.address_state || 'CA');
  const [zip, setZip] = useState(state.address_zip || state.zip);
  const [isOwner, setIsOwner] = useState(state.address_is_owner);
  const [email, setEmail] = useState(state.customer_email);
  const [additionalNotes, setAdditionalNotes] = useState(state.additional_notes);
  const [errors, setErrors] = useState<{ address_line1?: string; city?: string; state?: string; zip?: string }>({});

  const addressInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    if (!apiKey || typeof window === 'undefined') return

    loadGoogleMapsScript(apiKey).then(() => {
      if (!addressInputRef.current || !window.google?.maps?.places) {
        console.error('[castle] Google Maps Places not available after script load')
        return
      }
      const autocomplete = new window.google.maps.places.Autocomplete(addressInputRef.current, {
        types: ['address'],
        componentRestrictions: { country: 'us' },
        fields: ['address_components'],
      })
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace()
        if (!place.address_components) return

        let streetNumber = '', route = '', locality = '', adminArea = '', postal = ''
        for (const c of place.address_components) {
          if (c.types.includes('street_number'))             streetNumber = c.long_name
          if (c.types.includes('route'))                     route        = c.long_name
          if (c.types.includes('locality'))                  locality     = c.long_name
          if (c.types.includes('administrative_area_level_1')) adminArea  = c.short_name
          if (c.types.includes('postal_code'))               postal       = c.long_name
        }

        setAddressLine1([streetNumber, route].filter(Boolean).join(' '))
        setCity(locality)
        setStateAbbr(adminArea)
        setZip(postal)
        setErrors({})
      })
    }).catch((err: unknown) => {
      console.error('[castle] Google Maps failed to load:', err)
    })
  }, [])

  function validate(): boolean {
    const errs: typeof errors = {};
    if (!addressLine1.trim()) errs.address_line1 = 'Street address is required.';
    if (!city.trim()) errs.city = 'City is required.';
    if (!stateAbbr.trim()) errs.state = 'State is required.';
    if (!zip.trim()) errs.zip = 'ZIP code is required.';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleSubmit() {
    if (!validate()) return;
    onNext({
      first_name: firstName.trim(),
      customer_last_name: lastName.trim(),
      address_line1: addressLine1.trim(),
      address_city: city.trim(),
      address_state: stateAbbr.trim(),
      address_zip: zip.trim(),
      address_is_owner: isOwner,
      customer_email: email.trim(),
      additional_notes: additionalNotes.trim(),
    });
  }

  const inputStyle = (hasError: boolean): React.CSSProperties => ({
    width: '100%',
    padding: '0.75rem 1rem',
    fontSize: '1rem',
    fontFamily: 'var(--font-body)',
    border: `1.5px solid ${hasError ? 'var(--color-primary)' : 'var(--color-border)'}`,
    borderRadius: 'var(--radius-input)',
    outline: 'none',
    backgroundColor: 'var(--color-white)',
    color: 'var(--color-text)',
    boxSizing: 'border-box',
  });

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-heading)',
    fontWeight: 600,
    fontSize: '0.875rem',
    color: 'var(--color-text)',
    marginBottom: '0.375rem',
  };

  const fieldStyle: React.CSSProperties = { marginBottom: '1rem' };

  const errorStyle: React.CSSProperties = {
    color: 'var(--color-primary)',
    fontSize: '0.8rem',
    marginTop: '0.25rem',
  };

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
        Where do you need service?
      </h2>
      <p style={{ color: 'var(--color-text-muted)', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
        We&apos;ll use this address for your appointment.
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ flex: 1 }}>
          <label htmlFor="first-name" style={labelStyle}>First Name</label>
          <input
            id="first-name"
            type="text"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            style={inputStyle(false)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="last-name" style={labelStyle}>
            Last Name <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            id="last-name"
            type="text"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Smith"
            style={inputStyle(false)}
          />
        </div>
      </div>

      <div style={fieldStyle}>
        <label htmlFor="address-line1" style={labelStyle}>
          Street Address <span style={{ color: 'var(--color-primary)' }}>*</span>
        </label>
        <input
          ref={addressInputRef}
          id="address-line1"
          type="text"
          autoComplete="off"
          value={addressLine1}
          onChange={(e) => {
            setAddressLine1(e.target.value);
            setErrors((prev) => ({ ...prev, address_line1: undefined }));
          }}
          placeholder="123 Main St"
          style={inputStyle(!!errors.address_line1)}
        />
        {errors.address_line1 && <p role="alert" style={errorStyle}>{errors.address_line1}</p>}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ flex: 2 }}>
          <label htmlFor="city" style={labelStyle}>
            City <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          <input
            id="city"
            type="text"
            autoComplete="address-level2"
            value={city}
            onChange={(e) => {
              setCity(e.target.value);
              setErrors((prev) => ({ ...prev, city: undefined }));
            }}
            placeholder="Los Angeles"
            style={inputStyle(!!errors.city)}
          />
          {errors.city && <p role="alert" style={errorStyle}>{errors.city}</p>}
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="state-abbr" style={labelStyle}>
            State <span style={{ color: 'var(--color-primary)' }}>*</span>
          </label>
          <input
            id="state-abbr"
            type="text"
            autoComplete="address-level1"
            maxLength={2}
            value={stateAbbr}
            onChange={(e) => {
              setStateAbbr(e.target.value.toUpperCase());
              setErrors((prev) => ({ ...prev, state: undefined }));
            }}
            placeholder="CA"
            style={inputStyle(!!errors.state)}
          />
          {errors.state && <p role="alert" style={errorStyle}>{errors.state}</p>}
        </div>
      </div>

      <div style={fieldStyle}>
        <label htmlFor="zip-code" style={labelStyle}>
          ZIP Code <span style={{ color: 'var(--color-primary)' }}>*</span>
        </label>
        <input
          id="zip-code"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={5}
          value={zip}
          onChange={(e) => {
            setZip(e.target.value.replace(/\D/g, '').slice(0, 5));
            setErrors((prev) => ({ ...prev, zip: undefined }));
          }}
          placeholder="91001"
          style={inputStyle(!!errors.zip)}
        />
        {errors.zip && <p role="alert" style={errorStyle}>{errors.zip}</p>}
      </div>

      <div style={fieldStyle}>
        <label htmlFor="customer-email" style={labelStyle}>
          Email <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          id="customer-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          style={inputStyle(false)}
        />
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.625rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={isOwner}
            onChange={(e) => setIsOwner(e.target.checked)}
            style={{
              width: '18px',
              height: '18px',
              marginTop: '1px',
              accentColor: 'var(--color-primary)',
              flexShrink: 0,
              cursor: 'pointer',
            }}
          />
          <span
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '0.9rem',
              color: 'var(--color-text)',
            }}
          >
            I am the property owner
          </span>
        </label>
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <label htmlFor="additional-notes" style={labelStyle}>
          Additional Notes <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>(optional)</span>
        </label>
        <textarea
          id="additional-notes"
          value={additionalNotes}
          onChange={(e) => setAdditionalNotes(e.target.value)}
          rows={3}
          placeholder="Gate code, parking instructions, etc."
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
      </div>

      <button
        type="button"
        onClick={handleSubmit}
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

      {/* Ensure Google's autocomplete dropdown renders above other elements */}
      <style>{`.pac-container { z-index: 9999 !important; }`}</style>
    </div>
  );
}
