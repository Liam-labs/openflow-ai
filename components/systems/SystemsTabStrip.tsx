'use client';

import React from 'react';
import type { EntityType, EntityTab, SystemsNavState } from './systems-types';
import { ENTITY_TABS } from './systems-types';

interface SystemsTabStripProps {
  navState: SystemsNavState;
  onTabChange: (tab: EntityTab) => void;
}

export function SystemsTabStrip({ navState, onTabChange }: SystemsTabStripProps) {
  const { entityType, tab } = navState;

  // Only render when viewing an entity detail
  if (!entityType) return null;

  const tabs = ENTITY_TABS[entityType] ?? [];
  const activeTab = tab ?? tabs[0]?.id;

  return (
    <div className="systems-tab-strip" role="tablist" aria-label="Entity detail tabs">
      {tabs.map((t) => {
        const isActive = t.id === activeTab;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            className={`systems-tab-strip__tab${isActive ? ' systems-tab-strip__tab--active' : ''}`}
            onClick={() => onTabChange(t.id as EntityTab)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
