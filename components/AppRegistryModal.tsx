'use client';

import { createElement, useState, useEffect, useCallback, useRef } from 'react';
import {
  X,
  Plus,
  Trash2,
  Save,
  ChevronDown,
  Search,
  Palette,
  Type,
  SmilePlus,
  Link,
  FolderOpen,
  Activity,
  GripVertical,
  AlertCircle,
  Check,
  Pencil,
  Power,
  MonitorCheck,
  BellRing,
  Cloud,
  ExternalLink,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { AppRegistryEntry, AppCategory } from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';

// ============================================
// Constants
// ============================================

const CATEGORIES: { value: AppCategory; label: string }[] = [
  { value: 'development', label: 'Development' },
  { value: 'ai', label: 'AI' },
  { value: 'media', label: 'Media' },
  { value: 'automation', label: 'Automation' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'utility', label: 'Utility' },
  { value: 'other', label: 'Other' },
];

const PRESET_COLORS = [
  '#3B82F6', // Blue
  '#8B5CF6', // Violet
  '#EC4899', // Pink
  '#EF4444', // Red
  '#F97316', // Orange
  '#EAB308', // Yellow
  '#22C55E', // Green
  '#06B6D4', // Cyan
  '#6366F1', // Indigo
  '#14B8A6', // Teal
];

/** Curated subset of popular Lucide icon names */
const POPULAR_ICONS = [
  'rocket', 'code', 'database', 'server', 'globe', 'terminal',
  'cpu', 'hard-drive', 'monitor', 'smartphone', 'layout-dashboard',
  'bot', 'brain', 'zap', 'shield', 'lock', 'key', 'eye',
  'image', 'video', 'music', 'file-text', 'folder', 'archive',
  'cloud', 'wifi', 'bluetooth', 'mail', 'message-square', 'bell',
  'calendar', 'clock', 'timer', 'git-branch', 'git-merge',
  'package', 'box', 'layers', 'grid-3x3', 'bar-chart-3',
  'activity', 'heart', 'star', 'bookmark', 'flag',
  'settings', 'wrench', 'hammer', 'paintbrush', 'pen-tool',
  'camera', 'mic', 'headphones', 'speaker', 'play',
  'download', 'upload', 'share-2', 'link', 'external-link',
  'search', 'filter', 'sliders-horizontal', 'gauge',
  'truck', 'map-pin', 'compass', 'navigation',
];

function resolveLucideIcon(name: string): LucideIcons.LucideIcon | null {
  const pascal = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const icons = LucideIcons as unknown as Record<string, LucideIcons.LucideIcon>;
  return icons[pascal] || null;
}

type FormData = {
  name: string;
  description: string;
  icon: string;
  iconType: 'emoji' | 'lucide';
  color: string;
  category: AppCategory;
  tags: string;
  url: string;
  path: string;
  pm2Name: string;
  alwaysOn: boolean;
  healthCheckEnabled: boolean;
  healthCheckType: 'port' | 'http';
  healthCheckTarget: string;
};

const emptyForm: FormData = {
  name: '',
  description: '',
  icon: '\u{1F4E6}',
  iconType: 'emoji',
  color: '#3B82F6',
  category: 'other',
  tags: '',
  url: '',
  path: '',
  pm2Name: '',
  alwaysOn: false,
  healthCheckEnabled: false,
  healthCheckType: 'port',
  healthCheckTarget: '',
};

interface AppRegistryModalProps {
  isOpen: boolean;
  onClose: () => void;
  apps: AppRegistryEntry[];
  onAppsChange: () => void;
  editingApp?: AppRegistryEntry | null;
}

// ============================================
// Sub-components
// ============================================

function IconPicker({
  value,
  iconType,
  onChange,
  onTypeChange,
  accentColor,
}: {
  value: string;
  iconType: 'emoji' | 'lucide';
  onChange: (icon: string) => void;
  onTypeChange: (type: 'emoji' | 'lucide') => void;
  accentColor: string;
}) {
  const [iconSearch, setIconSearch] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    }
    if (showPicker) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPicker]);

  const filteredIcons = iconSearch
    ? POPULAR_ICONS.filter((name) =>
        name.toLowerCase().includes(iconSearch.toLowerCase())
      )
    : POPULAR_ICONS;

  const hexToRgb = (hex: string) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`
      : '59,130,246';
  };
  const rgb = hexToRgb(accentColor);

  return (
    <div className="relative" ref={pickerRef}>
      <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
        Icon
      </label>

      {/* Toggle between emoji and lucide */}
      <div className="flex items-center gap-1 mb-2">
        <button
          type="button"
          onClick={() => onTypeChange('emoji')}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.7rem] font-medium transition-all duration-200 cursor-pointer ${
            iconType === 'emoji'
              ? 'bg-white/10 text-white/80 border border-white/15'
              : 'text-white/30 hover:text-white/50 border border-transparent'
          }`}
        >
          <SmilePlus className="w-3 h-3" />
          Emoji
        </button>
        <button
          type="button"
          onClick={() => {
            onTypeChange('lucide');
            if (iconType !== 'lucide') onChange('rocket');
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[0.7rem] font-medium transition-all duration-200 cursor-pointer ${
            iconType === 'lucide'
              ? 'bg-white/10 text-white/80 border border-white/15'
              : 'text-white/30 hover:text-white/50 border border-transparent'
          }`}
        >
          <Type className="w-3 h-3" />
          Lucide
        </button>
      </div>

      {iconType === 'emoji' ? (
        <div className="flex items-center gap-2">
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center text-2xl border border-white/10 bg-white/[0.03]"
            style={{
              boxShadow: `0 0 20px rgba(${rgb},0.1)`,
            }}
          >
            {value}
          </div>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="glass-input text-center text-xl w-16 py-1.5"
            placeholder="\u{1F4E6}"
            maxLength={4}
          />
          <span className="text-[0.65rem] text-white/25">Paste or type emoji</span>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center border border-white/10"
              style={{
                background: `rgba(${rgb},0.1)`,
                boxShadow: `0 0 20px rgba(${rgb},0.1)`,
              }}
            >
              <ResolvedIcon name={value} color={accentColor} size={20} />
            </div>
            <button
              type="button"
              onClick={() => setShowPicker(!showPicker)}
              className="glass-input flex items-center justify-between gap-2 py-2 cursor-pointer"
            >
              <span className="text-white/60 text-sm">{value || 'Select icon...'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-white/30" />
            </button>
          </div>

          {showPicker && (
            <div className="absolute z-50 left-0 right-0 mt-1 rounded-xl border border-white/10 bg-[rgba(8,14,30,0.97)] backdrop-blur-2xl shadow-2xl overflow-hidden"
              style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.7)' }}
            >
              <div className="p-2.5 border-b border-white/[0.06]">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" />
                  <input
                    type="text"
                    value={iconSearch}
                    onChange={(e) => setIconSearch(e.target.value)}
                    className="glass-input pl-8 py-1.5 text-sm"
                    placeholder="Search icons..."
                    autoFocus
                  />
                </div>
              </div>
              <div className="p-2 max-h-48 overflow-y-auto grid grid-cols-8 gap-1">
                {filteredIcons.map((name) => {
                  const Icon = resolveLucideIcon(name);
                  if (!Icon) return null;
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => {
                        onChange(name);
                        setShowPicker(false);
                        setIconSearch('');
                      }}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-150 cursor-pointer ${
                        value === name
                          ? 'bg-white/15 border border-white/20'
                          : 'hover:bg-white/10 border border-transparent'
                      }`}
                      title={name}
                    >
                      <Icon className="w-4 h-4 text-white/60" />
                    </button>
                  );
                })}
                {filteredIcons.length === 0 && (
                  <p className="col-span-8 text-center text-[0.7rem] text-white/25 py-4">
                    No icons match &ldquo;{iconSearch}&rdquo;
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div>
      <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
        Accent Color
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => onChange(color)}
            className={`w-7 h-7 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:scale-110 ${
              value === color
                ? 'border-white/50 scale-110 shadow-lg'
                : 'border-transparent hover:border-white/20'
            }`}
            style={{
              background: color,
              boxShadow:
                value === color ? `0 0 12px ${color}40` : undefined,
            }}
            title={color}
            aria-label={`Select color ${color}`}
          />
        ))}
        <div className="relative">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-7 h-7 rounded-lg cursor-pointer border-0 bg-transparent appearance-none"
            style={{ padding: 0 }}
            title="Custom color"
            aria-label="Pick custom color"
          />
          <Palette className="absolute inset-0 m-auto w-3.5 h-3.5 text-white/50 pointer-events-none" />
        </div>
      </div>
    </div>
  );
}

// ============================================
// Main Modal Component
// ============================================

export function AppRegistryModal({
  isOpen,
  onClose,
  apps,
  onAppsChange,
  editingApp,
}: AppRegistryModalProps) {
  const [view, setView] = useState<'list' | 'form'>('list');
  const [formData, setFormData] = useState<FormData>(emptyForm);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // When editingApp is provided, go straight to editing that app
  useEffect(() => {
    if (editingApp && isOpen) {
      setEditId(editingApp.id);
      setFormData({
        name: editingApp.name,
        description: editingApp.description,
        icon: editingApp.icon,
        iconType: editingApp.iconType,
        color: editingApp.color,
        category: editingApp.category,
        tags: editingApp.tags.join(', '),
        url: editingApp.url || '',
        path: editingApp.path || '',
        pm2Name: editingApp.pm2Name || '',
        alwaysOn: !!editingApp.alwaysOn,
        healthCheckEnabled: !!editingApp.healthCheck,
        healthCheckType: editingApp.healthCheck?.type || 'port',
        healthCheckTarget: editingApp.healthCheck?.target || '',
      });
      setView('form');
    }
  }, [editingApp, isOpen]);

  // Reset state when modal opens fresh (no editingApp)
  useEffect(() => {
    if (isOpen && !editingApp) {
      setView('list');
      setFormData(emptyForm);
      setEditId(null);
      setError('');
    }
  }, [isOpen, editingApp]);

  // Escape key to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (view === 'form') {
          setView('list');
          setFormData(emptyForm);
          setEditId(null);
        } else {
          onClose();
        }
      }
    }
    if (isOpen) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, view]);

  // Trap focus and prevent body scroll
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const handleStartEdit = (app: AppRegistryEntry) => {
    setEditId(app.id);
    setFormData({
      name: app.name,
      description: app.description,
      icon: app.icon,
      iconType: app.iconType,
      color: app.color,
      category: app.category,
      tags: app.tags.join(', '),
      url: app.url || '',
      path: app.path || '',
      pm2Name: app.pm2Name || '',
      alwaysOn: !!app.alwaysOn,
      healthCheckEnabled: !!app.healthCheck,
      healthCheckType: app.healthCheck?.type || 'port',
      healthCheckTarget: app.healthCheck?.target || '',
    });
    setView('form');
    setError('');
  };

  const handleStartCreate = () => {
    setEditId(null);
    setFormData(emptyForm);
    setView('form');
    setError('');
  };

  const handleSave = useCallback(async () => {
    if (!formData.name.trim()) {
      setError('Name is required');
      return;
    }
    if (formData.alwaysOn && !formData.pm2Name.trim()) {
      setError('Always On requires a PM2 process name');
      return;
    }
    if (formData.alwaysOn && (!formData.healthCheckEnabled || !formData.healthCheckTarget.trim())) {
      setError('Always On requires a health check');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const payload: Record<string, unknown> = {
        action: editId ? 'update' : 'create',
        name: formData.name.trim(),
        description: formData.description.trim(),
        icon: formData.icon,
        iconType: formData.iconType,
        color: formData.color,
        category: formData.category,
        tags: formData.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        url: formData.url.trim() || undefined,
        path: formData.path.trim() || undefined,
        pm2Name: formData.pm2Name.trim() || undefined,
        alwaysOn: formData.alwaysOn,
        healthCheck: formData.healthCheckEnabled
          ? {
              type: formData.healthCheckType,
              target: formData.healthCheckTarget.trim(),
            }
          : undefined,
      };

      if (editId) {
        payload.id = editId;
      }

      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to save');
        return;
      }

      onAppsChange();
      setView('list');
      setFormData(emptyForm);
      setEditId(null);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [formData, editId, onAppsChange]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch('/api/apps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id }),
        });
        const data = await res.json();
        if (data.success) {
          onAppsChange();
          setDeleteConfirm(null);
        }
      } catch {
        console.error('Failed to delete app');
      }
    },
    [onAppsChange]
  );

  const updateField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    if (error) setError('');
  };

  const canEnableAlwaysOn = Boolean(
    formData.pm2Name.trim()
    && formData.healthCheckEnabled
    && formData.healthCheckTarget.trim()
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={editId ? 'Edit App' : view === 'form' ? 'Add App' : 'App Registry'}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => {
          if (view === 'form') {
            setView('list');
            setFormData(emptyForm);
            setEditId(null);
          } else {
            onClose();
          }
        }}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        ref={modalRef}
        className="relative w-full max-w-2xl max-h-[85vh] mx-4 rounded-2xl border border-white/[0.08] overflow-hidden"
        style={{
          background: 'linear-gradient(180deg, rgba(10,18,38,0.97) 0%, rgba(6,10,24,0.98) 100%)',
          boxShadow: '0 40px 100px rgba(0,0,0,0.7), 0 0 0 1px rgba(59,130,246,0.08)',
          animation: 'modalSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            {view === 'form' && (
              <button
                onClick={() => {
                  setView('list');
                  setFormData(emptyForm);
                  setEditId(null);
                }}
                className="text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                aria-label="Back to list"
              >
                <ChevronDown className="w-4 h-4 rotate-90" />
              </button>
            )}
            <h2 className="text-base font-semibold text-white/85">
              {view === 'form'
                ? editId
                  ? 'Edit App'
                  : 'Add New App'
                : 'App Registry'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-white/25 hover:text-white/60 transition-colors p-1.5 rounded-lg hover:bg-white/5 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto" style={{ maxHeight: 'calc(85vh - 65px)' }}>
          {view === 'list' ? (
            <div className="p-4">
              {/* Add button */}
              <button
                onClick={handleStartCreate}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/10 text-white/40 text-sm hover:border-white/20 hover:text-white/60 hover:bg-white/[0.02] transition-all duration-200 mb-4 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add New App
              </button>

              {/* App list */}
              {apps.length === 0 ? (
                <div className="text-center py-12">
                  <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mx-auto mb-4">
                    <GripVertical className="w-6 h-6 text-white/15" />
                  </div>
                  <p className="text-white/30 text-sm mb-1">No apps registered</p>
                  <p className="text-white/15 text-xs">
                    Click &ldquo;Add New App&rdquo; to get started
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {apps.map((app) => {
                    const rgb = hexToRgbStr(app.color);
                    return (
                      <div
                        key={app.id}
                        className="flex items-center gap-3 p-3 rounded-xl border border-white/[0.04] hover:border-white/[0.08] hover:bg-white/[0.02] transition-all duration-200 group"
                      >
                        {/* Icon */}
                        <div
                          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{
                            background: `rgba(${rgb},0.1)`,
                            border: `1px solid rgba(${rgb},0.15)`,
                          }}
                        >
                          {app.iconType === 'emoji' ? (
                            <span className="text-lg">{app.icon}</span>
                          ) : (
                            <ResolvedIcon name={app.icon} color={app.color} size={16} />
                          )}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white/75 truncate">
                            {app.name}
                          </p>
                          <p className="text-[0.7rem] text-white/30 truncate">
                            {app.category} {app.url ? `- ${app.url}` : ''}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleStartEdit(app)}
                            className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-all cursor-pointer"
                            title="Edit"
                            aria-label={`Edit ${app.name}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          {deleteConfirm === app.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDelete(app.id)}
                                className="p-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all cursor-pointer"
                                title="Confirm delete"
                                aria-label={`Confirm delete ${app.name}`}
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="p-1.5 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-all cursor-pointer"
                                title="Cancel"
                                aria-label="Cancel delete"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(app.id)}
                              className="p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
                              title="Delete"
                              aria-label={`Delete ${app.name}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Form view */
            <div className="p-6 space-y-5">
              {/* Error bar */}
              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* Name */}
              <div>
                <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                  Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  className="glass-input"
                  placeholder="My Application"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                  Description
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => updateField('description', e.target.value)}
                  className="glass-input"
                  placeholder="A short description of what this app does"
                />
              </div>

              {/* Icon picker + Color picker side by side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <IconPicker
                  value={formData.icon}
                  iconType={formData.iconType}
                  onChange={(icon) => updateField('icon', icon)}
                  onTypeChange={(type) => updateField('iconType', type)}
                  accentColor={formData.color}
                />
                <ColorPicker
                  value={formData.color}
                  onChange={(color) => updateField('color', color)}
                />
              </div>

              {/* Category + Tags */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                    Category
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) =>
                      updateField('category', e.target.value as AppCategory)
                    }
                    className="glass-input appearance-none cursor-pointer"
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.value} value={cat.value} className="bg-[#0a1428] text-white">
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                    Tags
                  </label>
                  <input
                    type="text"
                    value={formData.tags}
                    onChange={(e) => updateField('tags', e.target.value)}
                    className="glass-input"
                    placeholder="react, frontend, dashboard"
                  />
                  <p className="text-[0.6rem] text-white/20 mt-1">
                    Comma-separated
                  </p>
                </div>
              </div>

              {/* URL + Path */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                    <Link className="w-3 h-3" />
                    URL
                  </label>
                  <input
                    type="url"
                    value={formData.url}
                    onChange={(e) => updateField('url', e.target.value)}
                    className="glass-input"
                    placeholder="http://localhost:3000"
                  />
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                    <FolderOpen className="w-3 h-3" />
                    Path
                  </label>
                  <input
                    type="text"
                    value={formData.path}
                    onChange={(e) => updateField('path', e.target.value)}
                    className="glass-input"
                    placeholder="/home/user/project"
                  />
                </div>

                {/* PM2 Name */}
                <div>
                  <label className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-white/30 mb-1.5 font-medium">
                    <Activity className="w-3 h-3" />
                    PM2 Process Name
                  </label>
                  <input
                    type="text"
                    value={formData.pm2Name}
                    onChange={(e) => updateField('pm2Name', e.target.value)}
                    className="glass-input"
                    placeholder="my-app (for auto-start)"
                  />
                  <p className="text-[0.65rem] text-white/20 mt-1">
                    PM2 process name to start when app is offline
                  </p>
                </div>
              </div>

              {/* WebGate hosting — read-only, sourced from gateway-services.json */}
              {editId && (
                <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Cloud className={`h-3.5 w-3.5 ${editingApp?.webGate?.status === 'active' ? 'text-blue-400' : 'text-white/25'}`} />
                        <span className="text-[0.7rem] font-medium uppercase tracking-wider text-white/45">WebGate</span>
                        {editingApp?.webGate && (
                          <span className={`rounded px-1.5 py-0.5 text-[0.58rem] font-medium uppercase tracking-wide ${
                            editingApp.webGate.status === 'active'
                              ? 'bg-emerald-400/10 text-emerald-300/75'
                              : 'bg-amber-400/10 text-amber-300/70'
                          }`}>
                            {editingApp.webGate.status}
                          </span>
                        )}
                      </div>

                      {editingApp?.webGate ? (
                        <>
                          <p className="mt-1.5 text-[0.7rem] text-white/40">
                            {editingApp.webGate.status === 'active' ? 'Hosted through WebGate' : 'Configured in WebGate but not currently active'}
                          </p>
                          <a
                            href={editingApp.webGate.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 flex max-w-full items-center gap-1.5 text-[0.7rem] text-blue-300/75 transition-colors hover:text-blue-200"
                            title={editingApp.webGate.url}
                          >
                            <span className="truncate">{editingApp.webGate.url}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        </>
                      ) : (
                        <p className="mt-1.5 text-[0.7rem] text-white/25">Not hosted through WebGate</p>
                      )}
                    </div>

                    {editingApp?.webGate && (
                      <div className="flex shrink-0 items-center gap-1.5 text-[0.62rem] text-white/30" title={editingApp.webGate.locked ? 'Protected by WebGate Access' : 'Public WebGate route'}>
                        {editingApp.webGate.locked ? (
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/65" />
                        ) : (
                          <ShieldOff className="h-3.5 w-3.5 text-white/25" />
                        )}
                        <span>{editingApp.webGate.locked ? 'Protected' : 'Public'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Health Check */}
              <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] p-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-white/30 font-medium">
                    <Activity className="w-3 h-3" />
                    Health Check
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      updateField(
                        'healthCheckEnabled',
                        !formData.healthCheckEnabled
                      )
                    }
                    className={`relative w-9 h-5 rounded-full transition-all duration-200 cursor-pointer ${
                      formData.healthCheckEnabled
                        ? 'bg-blue-500/40 border border-blue-500/50'
                        : 'bg-white/10 border border-white/10'
                    }`}
                    role="switch"
                    aria-checked={formData.healthCheckEnabled}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full transition-all duration-200 ${
                        formData.healthCheckEnabled
                          ? 'left-4 bg-blue-400'
                          : 'left-0.5 bg-white/40'
                      }`}
                    />
                  </button>
                </div>

                {formData.healthCheckEnabled && (
                  <div className="flex items-center gap-3">
                    <select
                      value={formData.healthCheckType}
                      onChange={(e) =>
                        updateField(
                          'healthCheckType',
                          e.target.value as 'port' | 'http'
                        )
                      }
                      className="glass-input w-24 appearance-none cursor-pointer text-sm"
                    >
                      <option value="port" className="bg-[#0a1428]">Port</option>
                      <option value="http" className="bg-[#0a1428]">HTTP</option>
                    </select>
                    <input
                      type="text"
                      value={formData.healthCheckTarget}
                      onChange={(e) =>
                        updateField('healthCheckTarget', e.target.value)
                      }
                      className="glass-input flex-1"
                      placeholder={
                        formData.healthCheckType === 'port'
                          ? '3000'
                          : 'http://localhost:3000/api/health'
                      }
                    />
                  </div>
                )}
              </div>

              {/* Always On policy */}
              <div
                className={`rounded-xl border p-4 transition-colors ${
                  formData.alwaysOn
                    ? 'border-emerald-400/20 bg-emerald-400/[0.035]'
                    : 'border-white/[0.05] bg-white/[0.01]'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <label className="flex items-center gap-1.5 text-[0.7rem] uppercase tracking-wider text-white/45 font-medium">
                      <Power className={`w-3 h-3 ${formData.alwaysOn ? 'text-emerald-400' : ''}`} />
                      Always On
                    </label>
                    <p id="always-on-description" className="mt-1.5 max-w-lg text-[0.7rem] leading-relaxed text-white/30">
                      Starts after {PRODUCT_NAME} on Windows and continuously watches this app. Failures are restarted, logged, and raised as alerts.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateField('alwaysOn', !formData.alwaysOn)}
                    disabled={!formData.alwaysOn && !canEnableAlwaysOn}
                    className={`relative mt-0.5 w-9 h-5 shrink-0 rounded-full border transition-all duration-200 ${
                      formData.alwaysOn
                        ? 'cursor-pointer border-emerald-400/50 bg-emerald-500/40'
                        : canEnableAlwaysOn
                          ? 'cursor-pointer border-white/10 bg-white/10'
                          : 'cursor-not-allowed border-white/[0.06] bg-white/[0.04] opacity-50'
                    }`}
                    role="switch"
                    aria-checked={formData.alwaysOn}
                    aria-describedby="always-on-description"
                    aria-label="Always On"
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200 ${
                        formData.alwaysOn ? 'left-4 bg-emerald-300' : 'left-0.5 bg-white/40'
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2">
                  {[
                    { icon: Power, label: 'Windows startup' },
                    { icon: MonitorCheck, label: '30s watcher' },
                    { icon: BellRing, label: 'Logs + alerts' },
                  ].map(({ icon: StatusIcon, label }) => (
                    <div key={label} className="flex items-center gap-1.5 rounded-md border border-white/[0.05] bg-black/10 px-2 py-1.5 text-[0.62rem] text-white/30">
                      <StatusIcon className={`h-3 w-3 shrink-0 ${formData.alwaysOn ? 'text-emerald-400/70' : 'text-white/20'}`} />
                      <span>{label}</span>
                    </div>
                  ))}
                </div>

                {!canEnableAlwaysOn && !formData.alwaysOn && (
                  <p className="mt-2 text-[0.62rem] text-amber-300/55">
                    Add a PM2 process name and enable a health check to turn this on.
                  </p>
                )}
              </div>

              {/* Save button */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={() => {
                    setView('list');
                    setFormData(emptyForm);
                    setEditId(null);
                  }}
                  className="glass-button secondary text-sm cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="glass-button primary flex items-center gap-2 text-sm cursor-pointer"
                >
                  {saving ? (
                    <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  {editId ? 'Update' : 'Create'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes modalSlideIn {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}

// ============================================
// Helper components
// ============================================

function ResolvedIcon({
  name,
  color,
  size = 16,
}: {
  name: string;
  color: string;
  size?: number;
}) {
  const Icon = resolveLucideIcon(name);
  if (!Icon) return <span className="text-sm">{'\u{1F4E6}'}</span>;
  return createElement(Icon, { style: { color, width: size, height: size } });
}

function hexToRgbStr(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `${parseInt(result[1], 16)},${parseInt(result[2], 16)},${parseInt(result[3], 16)}`
    : '59,130,246';
}
