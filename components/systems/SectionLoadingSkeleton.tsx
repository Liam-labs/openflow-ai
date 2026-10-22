'use client';

import React from 'react';

interface SectionLoadingSkeletonProps {
  rows?: number;
  showHeader?: boolean;
}

export function SectionLoadingSkeleton({ rows = 6, showHeader = true }: SectionLoadingSkeletonProps) {
  return (
    <div className="systems-section">
      {showHeader && (
        <div className="systems-section__header">
          <div className="sk-shimmer" style={{ width: 120, height: 18, borderRadius: 6 }} />
          <div className="sk-shimmer" style={{ width: 60, height: 28, borderRadius: 6 }} />
        </div>
      )}
      <div className="sk-table">
        <div className="sk-table__head">
          {[140, 100, 110, 70, 80, 70, 90].map((w, i) => (
            <div key={i} className="sk-shimmer" style={{ width: w, height: 12, borderRadius: 4 }} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="sk-table__row" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="sk-shimmer" style={{ width: '28%', height: 14, borderRadius: 4 }} />
            <div className="sk-shimmer" style={{ width: 72, height: 20, borderRadius: 10 }} />
            <div className="sk-shimmer" style={{ width: 80, height: 13, borderRadius: 4 }} />
            <div className="sk-shimmer" style={{ width: 48, height: 13, borderRadius: 4 }} />
            <div className="sk-shimmer" style={{ width: 56, height: 13, borderRadius: 4 }} />
            <div className="sk-shimmer" style={{ width: 44, height: 13, borderRadius: 4 }} />
            <div className="sk-shimmer" style={{ width: 60, height: 13, borderRadius: 4 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
