import { useState, useEffect, type RefObject } from 'react';

/**
 * Returns true once the referenced element intersects the viewport.
 * Disconnects the observer after the first intersection when once=true (default).
 */
export function useIntersection(
  ref: RefObject<Element | null>,
  threshold = 0.15,
  once = true,
): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          if (once) obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref, threshold, once]);
  return visible;
}
