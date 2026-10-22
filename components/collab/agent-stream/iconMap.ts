'use client';

/**
 * Sprint 5 — Maps interpreter IconName strings to Lucide React components.
 * Kept in a single file so tree-shaking can eliminate unused icons and so
 * the icon list stays in sync with the IconName union in lib/agent-stream-interpret/types.ts.
 */

import type { LucideIcon } from 'lucide-react';
import {
  FileText,
  Edit3,
  Search,
  FolderSearch,
  Terminal,
  Globe,
  Database,
  GitPullRequest,
  GitBranch,
  Package,
  Cloud,
  Brain,
  Sparkles,
  Mail,
  Calendar,
  Image,
  FileCog,
  ClipboardList,
  Bell,
  Clock,
  Plug,
  Eye,
  Map,
  Settings,
  Shield,
  Beaker,
  MessageSquare,
  HelpCircle,
  Rocket,
  BarChart,
  Tag,
  PenTool,
  Home,
  Smartphone,
  Keyboard,
  GraduationCap,
  Wrench,
} from 'lucide-react';
import type { IconName } from '@/lib/agent-stream-interpret/types';

export const ICON_MAP: Record<IconName, LucideIcon> = {
  'file-text': FileText,
  'edit-3': Edit3,
  'search': Search,
  'folder-search': FolderSearch,
  'terminal': Terminal,
  'globe': Globe,
  'database': Database,
  'git-pull-request': GitPullRequest,
  'git-branch': GitBranch,
  'package': Package,
  'cloud': Cloud,
  'brain': Brain,
  'sparkles': Sparkles,
  'mail': Mail,
  'calendar': Calendar,
  'image': Image,
  'file-cog': FileCog,
  'clipboard-list': ClipboardList,
  'bell': Bell,
  'clock': Clock,
  'plug': Plug,
  'eye': Eye,
  'map': Map,
  'settings': Settings,
  'shield': Shield,
  'beaker': Beaker,
  'message-square': MessageSquare,
  'help-circle': HelpCircle,
  'rocket': Rocket,
  'bar-chart': BarChart,
  'tag': Tag,
  'pen-tool': PenTool,
  'home': Home,
  'smartphone': Smartphone,
  'keyboard': Keyboard,
  'graduation-cap': GraduationCap,
  'wrench': Wrench,
};

export function getIcon(name: IconName): LucideIcon {
  return ICON_MAP[name] ?? Wrench;
}
