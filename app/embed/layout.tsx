import type { ReactNode } from 'react';
import { DM_Sans, Source_Sans_3 } from 'next/font/google';
import HeightReporter from './HeightReporter';

// Self-hosted via next/font: the old <link> to fonts.googleapis.com was a
// RENDER-BLOCKING external stylesheet — the browser painted nothing (not even
// the loading skeleton) until Google's CSS + font files resolved. next/font
// serves the fonts from our own origin with immutable caching and zero
// external round trips.
const dmSans = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--next-font-heading' });
const sourceSans = Source_Sans_3({ subsets: ['latin'], weight: ['400', '500', '600'], display: 'swap', variable: '--next-font-body' });

export const metadata = {
  robots: 'noindex, nofollow',
};

export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${sourceSans.variable}`}>
      <head>
        <style>{`
          :root {
            --color-primary: #C81E1E;
            --color-primary-hover: #A01818;
            --color-bg: #F5F5F3;
            --color-white: #FFFFFF;
            --color-text: #1A1A1A;
            --color-text-muted: #6B6B6B;
            --color-border: #B4B4B2;
            --shadow-card: 0 2px 8px rgba(0,0,0,0.08);
            --radius-card: 10px;
            --radius-input: 6px;
            --radius-large: 14px;
            --font-heading: var(--next-font-heading), 'DM Sans', sans-serif;
            --font-body: var(--next-font-body), 'Source Sans 3', sans-serif;
          }
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: var(--font-body); color: var(--color-text); }
          input, textarea, select {
            background-color: var(--color-bg) !important;
            color: var(--color-text) !important;
          }
          input::placeholder, textarea::placeholder {
            color: var(--color-text-muted);
            opacity: 1;
          }
        `}</style>
      </head>
      <body style={{ margin: 0, padding: 0, background: 'var(--color-bg)' }}>
        <HeightReporter />
        {children}
      </body>
    </html>
  );
}
