import { useState, useEffect } from 'react';

/**
 * Returns true when window.scrollY exceeds threshold.
 * Sets initial state immediately on mount (avoids flash on page load).
 */
export function useScrolled(threshold = 60): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > threshold);
    window.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => window.removeEventListener('scroll', handler);
  }, [threshold]);
  return scrolled;
}
