'use client';

import { useState, useEffect } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

interface BreakpointState {
  breakpoint: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  width: number;
}

const MOBILE_MAX = 767;   // < 768px
const TABLET_MAX = 1023;  // 768px - 1023px
// Desktop: >= 1024px

function getBreakpoint(width: number): Breakpoint {
  if (width <= MOBILE_MAX) return 'mobile';
  if (width <= TABLET_MAX) return 'tablet';
  return 'desktop';
}

/**
 * Detects current screen breakpoint using matchMedia.
 * Updates reactively on resize. SSR-safe (defaults to 'desktop').
 */
export function useBreakpoint(): BreakpointState {
  // The first client render must match the server; measure after hydration.
  const [state, setState] = useState<BreakpointState>({
    breakpoint: 'desktop', isMobile: false, isTablet: false, isDesktop: true, width: 1280,
  });

  useEffect(() => {
    const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`);
    const tabletQuery = window.matchMedia(`(min-width: ${MOBILE_MAX + 1}px) and (max-width: ${TABLET_MAX}px)`);

    const update = () => {
      const width = window.innerWidth;
      const breakpoint = getBreakpoint(width);
      setState({
        breakpoint,
        isMobile: breakpoint === 'mobile',
        isTablet: breakpoint === 'tablet',
        isDesktop: breakpoint === 'desktop',
        width,
      });
    };

    mobileQuery.addEventListener('change', update);
    tabletQuery.addEventListener('change', update);

    // Initial sync (in case window size changed before effect ran)
    update();

    return () => {
      mobileQuery.removeEventListener('change', update);
      tabletQuery.removeEventListener('change', update);
    };
  }, []);

  return state;
}
