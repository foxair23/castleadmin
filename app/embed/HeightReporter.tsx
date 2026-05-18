'use client';

import { useEffect } from 'react';

export default function HeightReporter() {
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const height = document.body.scrollHeight;
      window.parent.postMessage(
        { type: 'castle-scheduler-height', height },
        '*'
      );
    });

    observer.observe(document.body);

    // Send initial height
    const height = document.body.scrollHeight;
    window.parent.postMessage(
      { type: 'castle-scheduler-height', height },
      '*'
    );

    return () => observer.disconnect();
  }, []);

  return null;
}
