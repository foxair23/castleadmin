import type { ReactNode } from 'react';
import HeightReporter from './HeightReporter';

export const metadata = {
  robots: 'noindex, nofollow',
};

export default function EmbedLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Source+Sans+3:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <style>{`
          :root {
            --color-primary: #C81E1E;
            --color-primary-hover: #A01818;
            --color-bg: #F5F5F3;
            --color-white: #FFFFFF;
            --color-text: #1A1A1A;
            --color-text-muted: #6B6B6B;
            --color-border: #E0E0DE;
            --shadow-card: 0 2px 8px rgba(0,0,0,0.08);
            --radius-card: 10px;
            --radius-input: 6px;
            --radius-large: 14px;
            --font-heading: 'DM Sans', sans-serif;
            --font-body: 'Source Sans 3', sans-serif;
          }
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: var(--font-body); }
        `}</style>
      </head>
      <body style={{ margin: 0, padding: 0, background: 'var(--color-bg)' }}>
        <HeightReporter />
        {children}
      </body>
    </html>
  );
}
