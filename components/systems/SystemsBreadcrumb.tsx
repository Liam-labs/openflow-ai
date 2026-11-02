'use client';

import React from 'react';
import { ChevronRight, Home } from 'lucide-react';
import type { BreadcrumbSegment, SystemsNavState } from './systems-types';
import { keyProvider, PROVIDER_PREFIX } from './connections/provider-link';
import { SECTION_LABELS } from './systems-types';

interface SystemsBreadcrumbProps {
  navState: SystemsNavState;
  onNavigate: (state: Partial<SystemsNavState>) => void;
}

export function SystemsBreadcrumb({ navState, onNavigate }: SystemsBreadcrumbProps) {
  const segments = buildSegments(navState);

  return (
    <nav className="systems-breadcrumb" aria-label="Systems navigation breadcrumb">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 && (
              <ChevronRight
                size={13}
                className="systems-breadcrumb__separator"
                aria-hidden="true"
              />
            )}
            {isLast ? (
              <span className="systems-breadcrumb__segment systems-breadcrumb__segment--active">
                {seg.label}
              </span>
            ) : (
              <button
                className="systems-breadcrumb__segment systems-breadcrumb__segment--link"
                onClick={() => handleClick(seg, onNavigate)}
                aria-label={`Navigate to ${seg.label}`}
              >
                {i === 0 ? (
                  <>
                    <Home size={12} aria-hidden="true" />
                    <span>{seg.label}</span>
                  </>
                ) : (
                  seg.label
                )}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function buildSegments(navState: SystemsNavState): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [
    { label: 'Systems', section: 'overview' },
  ];

  if (navState.section && navState.section !== 'overview') {
    segments.push({
      label: SECTION_LABELS[navState.section],
      section: navState.section,
    });
  }

  if (navState.entityId && navState.entityType) {
    // Entity name will come from navState once populated
    segments.push({
      label: navState.section === 'connections' && navState.entityId.startsWith(PROVIDER_PREFIX)
        ? keyProvider(navState.entityId.slice(PROVIDER_PREFIX.length))?.label ?? navState.entityId
        : navState.entityId,
      section: navState.section,
      entityId: navState.entityId,
    });
  }

  return segments;
}

function handleClick(
  seg: BreadcrumbSegment,
  onNavigate: (state: Partial<SystemsNavState>) => void
) {
  if (seg.entityId) {
    // Navigate back to entity (shouldn't happen in breadcrumb but handled)
    onNavigate({ section: seg.section, entityId: seg.entityId });
  } else if (seg.section) {
    // Navigate to section, clearing entity selection
    onNavigate({ section: seg.section, entityId: undefined, entityType: undefined, tab: undefined });
  }
}
