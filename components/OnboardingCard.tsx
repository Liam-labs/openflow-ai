'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutGrid,
  FolderPlus,
  Activity,
  MessageSquare,
  BookOpen,
  X,
  Check,
  ArrowRight,
} from 'lucide-react';
import { useOnboarding } from '@/lib/hooks/useOnboarding';
import { TabType } from './TabNavigation';
import { PRODUCT_NAME } from '@/lib/brand';

interface OnboardingCardProps {
  userName?: string;
  teamName?: string;
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  onDismiss: () => void;
  onOpenAddProject: () => void;
  projectCount: number;
}

type ItemId = 'explore-apps' | 'create-project' | 'check-systems' | 'open-collab' | 'browse-docs';

interface Item {
  id: ItemId;
  title: string;
  description: string;
  Icon: React.ElementType;
  onAction: () => void;
}

export function OnboardingCard({
  userName,
  teamName,
  activeTab,
  onTabChange,
  onDismiss,
  onOpenAddProject,
  projectCount,
}: OnboardingCardProps) {
  const router = useRouter();
  const { completed, markComplete, dismiss } = useOnboarding();

  const items: Item[] = [
    {
      id: 'explore-apps',
      title: 'Explore the App Library',
      description: `Browse available apps and discover what ${PRODUCT_NAME} can manage.`,
      Icon: LayoutGrid,
      onAction: () => {
        onTabChange('apps');
        markComplete('explore-apps');
      },
    },
    {
      id: 'create-project',
      title: 'Create Your First Project',
      description: 'Register a site or service to start monitoring it.',
      Icon: FolderPlus,
      onAction: () => {
        onTabChange('apps');
        onOpenAddProject();
      },
    },
    {
      id: 'check-systems',
      title: 'Check System Health',
      description: "See what's running on your machine — processes, ports, services.",
      Icon: Activity,
      onAction: () => {
        onTabChange('servers');
        markComplete('check-systems');
      },
    },
    {
      id: 'open-collab',
      title: 'Open Projects',
      description: 'Chat with your agent team and start working together.',
      Icon: MessageSquare,
      onAction: () => {
        markComplete('open-collab');
        router.push('/');
      },
    },
    {
      id: 'browse-docs',
      title: 'Browse Documentation',
      description: `Learn how ${PRODUCT_NAME} works and find answers.`,
      Icon: BookOpen,
      onAction: () => {
        onTabChange('docs');
        markComplete('browse-docs');
      },
    },
  ];

  // Auto-complete: Apps tab is the first view, mark it on mount
  useEffect(() => {
    markComplete('explore-apps');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-complete on tab navigation
  useEffect(() => {
    if (activeTab === 'servers') markComplete('check-systems');
    if (activeTab === 'docs') markComplete('browse-docs');
  }, [activeTab, markComplete]);

  // Auto-complete when a project is registered
  useEffect(() => {
    if (projectCount > 0) markComplete('create-project');
  }, [projectCount, markComplete]);

  const allDone = items.every((item) => completed.includes(item.id));
  const doneCount = items.filter((item) => completed.includes(item.id)).length;

  const handleDismiss = () => {
    dismiss();
    onDismiss();
  };

  return (
    <AnimatePresence>
      <motion.div
        className="relative"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
      >
        {/* Subtle gradient glow border */}
        <div
          className="absolute inset-0 rounded-[18px] pointer-events-none"
          aria-hidden="true"
          style={{
            background:
              'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(34,197,94,0.16) 50%, rgba(59,130,246,0.22) 100%)',
            filter: 'blur(12px)',
            zIndex: 0,
          }}
        />

        <div
          className="glass-card p-6 relative z-10"
          style={{ borderColor: 'rgba(59,130,246,0.25)' }}
        >
          <AnimatePresence mode="wait">
            {allDone ? (
              /* All done — minimal single-line view */
              <motion.div
                key="all-done"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="p-1.5 rounded-full"
                    style={{
                      background: 'rgba(34,197,94,0.15)',
                      border: '1px solid rgba(34,197,94,0.3)',
                    }}
                  >
                    <Check className="w-4 h-4 text-green-400" />
                  </div>
                  <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
                    You&apos;re all set — enjoy {PRODUCT_NAME}.
                  </span>
                </div>
                <button
                  onClick={handleDismiss}
                  className="text-white/30 hover:text-white/60 transition-colors"
                  aria-label="Dismiss"
                >
                  <X className="w-4 h-4" />
                </button>
              </motion.div>
            ) : (
              /* Main onboarding view */
              <motion.div
                key="onboarding"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
              >
                {/* Header row */}
                <div className="flex items-start justify-between mb-5">
                  <div>
                    <h2 className="text-base font-semibold text-white flex items-center gap-2">
                      <span aria-hidden="true">👋</span>
                      Welcome to {PRODUCT_NAME}{userName ? `, ${userName}` : ''}!
                    </h2>
                    <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.45)' }}>
                      {teamName ? `Your ${teamName} team is ready.` : 'Your team is ready.'}{' '}
                      Here&apos;s how to get started.
                    </p>
                  </div>
                  <button
                    onClick={handleDismiss}
                    className="text-white/30 hover:text-white/60 transition-colors ml-4 flex-shrink-0 mt-0.5"
                    aria-label="Dismiss onboarding"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Items grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
                  {items.map(({ id, title, description, Icon, onAction }) => {
                    const done = completed.includes(id);
                    return (
                      <div
                        key={id}
                        className="relative rounded-xl p-4 transition-all"
                        style={{
                          background: done
                            ? 'rgba(34,197,94,0.06)'
                            : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${done ? 'rgba(34,197,94,0.22)' : 'rgba(255,255,255,0.08)'}`,
                          opacity: done ? 0.65 : 1,
                        }}
                      >
                        {/* Completion check badge */}
                        {done && (
                          <div className="absolute top-3 right-3">
                            <div
                              className="p-0.5 rounded-full"
                              style={{
                                background: 'rgba(34,197,94,0.2)',
                                border: '1px solid rgba(34,197,94,0.35)',
                              }}
                            >
                              <Check className="w-3 h-3 text-green-400" />
                            </div>
                          </div>
                        )}

                        {/* Icon */}
                        <div
                          className="p-2 rounded-lg w-fit mb-3"
                          style={{
                            background: 'rgba(59,130,246,0.1)',
                            border: '1px solid rgba(59,130,246,0.15)',
                          }}
                        >
                          <Icon className="w-4 h-4 text-blue-400" aria-hidden="true" />
                        </div>

                        <p className="text-sm font-medium text-white/90 mb-1 pr-5">{title}</p>
                        <p className="text-xs mb-3" style={{ color: 'rgba(255,255,255,0.4)' }}>
                          {description}
                        </p>

                        <button
                          onClick={done ? undefined : onAction}
                          disabled={done}
                          className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                            done
                              ? 'text-green-400/70 cursor-default'
                              : 'text-blue-400 hover:text-blue-300 cursor-pointer'
                          }`}
                        >
                          {done ? (
                            <>
                              Done <Check className="w-3 h-3" />
                            </>
                          ) : (
                            <>
                              Go <ArrowRight className="w-3 h-3" />
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* Footer: dismiss link + progress */}
                <div
                  className="flex items-center justify-between pt-3"
                  style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <button
                    onClick={handleDismiss}
                    className="text-xs transition-colors hover:text-white/50"
                    style={{ color: 'rgba(255,255,255,0.28)' }}
                  >
                    Dismiss — I&apos;ll explore on my own
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'rgba(255,255,255,0.28)' }}>
                      {doneCount}/{items.length}
                    </span>
                    <div className="flex gap-1" role="progressbar" aria-valuenow={doneCount} aria-valuemax={items.length}>
                      {items.map((item) => (
                        <div
                          key={item.id}
                          className="w-1.5 h-1.5 rounded-full transition-colors duration-300"
                          style={{
                            background: completed.includes(item.id)
                              ? '#22c55e'
                              : 'rgba(255,255,255,0.18)',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
