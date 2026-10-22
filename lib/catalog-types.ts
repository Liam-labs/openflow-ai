/**
 * Systems Catalog — Type Definitions
 *
 * The catalog indexes every DevFlow feature and system, enabling
 * automated audit, issue tracking, and improvement workflows.
 */

// ─── Feature Categories ─────────────────────────────────────────────────────

export type FeatureCategory =
  | 'dashboard'
  | 'collab'
  | 'agents'
  | 'sprints'
  | 'services'
  | 'scheduling'
  | 'ai-tasks'
  | 'browser-testing'
  | 'monitoring'
  | 'knowledge'
  | 'settings'
  | 'auth'
  | 'bridges'
  | 'computer-use'
  | 'gateway'
  | 'infrastructure';

export type FeatureStatus =
  | 'discovered'       // Known to exist, not yet cataloged
  | 'cataloged'        // Code mapping complete, ready for audit
  | 'audited'          // QE has tested it, results recorded
  | 'needs-work'       // Audit found issues, improvements filed
  | 'improved'         // Fixes applied, awaiting re-audit
  | 'verified';        // Re-audit passed, no outstanding issues

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Complexity = 'low' | 'medium' | 'high';

// ─── Health Check ────────────────────────────────────────────────────────────

export interface HealthCheck {
  endpoint: string;                   // e.g. "POST /api/agent"
  method: string;                     // HTTP method
  body?: Record<string, unknown>;     // Request body for POST
  expectedStatus: number;             // e.g. 200
  expectedShape?: string;             // Brief description of expected response
}

// ─── Audit Types ─────────────────────────────────────────────────────────────

export interface AuditFinding {
  severity: Severity;
  title: string;
  description: string;
  suggestedFix?: string;
  taskId?: string;                    // Sprint task ID if filed
}

export interface AuditResult {
  id: string;                         // UUID
  date: string;                       // ISO timestamp
  auditor: string;                    // Agent name (e.g. "QE-Agent")
  passed: boolean;
  findings: AuditFinding[];
  notes: string;
}

// ─── Issue & Improvement Types ───────────────────────────────────────────────

export interface KnownIssue {
  id: string;                         // UUID
  title: string;
  severity: Severity;
  description: string;
  discoveredAt: string;
  resolvedAt: string | null;
  taskId?: string;                    // Sprint task ID if filed
}

export interface ImprovementEntry {
  id: string;                         // UUID
  date: string;
  description: string;
  agent: string;                      // Who did the work
  taskId?: string;                    // Sprint task reference
}

// ─── Core Feature Interface ──────────────────────────────────────────────────

export interface CatalogFeature {
  // Identity
  id: string;                         // UUID v4
  name: string;                       // Human-readable: "Sprint Board"
  slug: string;                       // Kebab-case: "sprint-board"
  category: FeatureCategory;
  description: string;                // 1-2 sentence summary

  // Code mapping
  apiRoutes: string[];                // e.g. ["/api/agent (sprints.*)", "/api/collab/tasks"]
  apiActions: string[];               // e.g. ["sprints.create", "sprints.activate"]
  uiComponents: string[];             // e.g. ["SprintPanel.tsx", "TaskBoard.tsx"]
  sourceFiles: string[];              // e.g. ["app/api/agent/actions/sprints.ts"]
  dataFiles: string[];                // e.g. [".AppData/collab-tasks.json"]

  // Relationships
  dependencies: string[];             // slugs of features this depends on
  actionCount: number;                // total API actions in this feature

  // Health
  healthCheck: HealthCheck | null;
  status: FeatureStatus;
  complexity: Complexity;

  // Audit summary (denormalized for quick reads)
  lastAuditedAt: string | null;
  lastAuditResult: AuditResult | null;
  knownIssues: KnownIssue[];
  improvementHistory: ImprovementEntry[];

  // Metadata
  createdAt: string;
  updatedAt: string;
}

// ─── On-Disk Schema ──────────────────────────────────────────────────────────

/** Stored variants include featureSlug reference (flat, not nested) */
export interface StoredAudit extends AuditResult {
  featureSlug: string;
}

export interface StoredIssue extends KnownIssue {
  featureSlug: string;
}

export interface StoredImprovement extends ImprovementEntry {
  featureSlug: string;
}

export interface SystemsCatalogFile {
  version: string;                      // Schema version (semver)
  lastModified: string;                 // ISO timestamp
  features: CatalogFeature[];
  audits: StoredAudit[];
  issues: StoredIssue[];
  improvements: StoredImprovement[];
}

// ─── Store Interface ─────────────────────────────────────────────────────────

export interface FeatureFilters {
  category?: FeatureCategory;
  status?: FeatureStatus;
  complexity?: Complexity;
  q?: string;                          // name/description substring
  limit?: number;
  offset?: number;
}

export interface CatalogStore {
  // Features
  listFeatures(filters?: FeatureFilters): Promise<{ features: CatalogFeature[]; total: number }>;
  getFeature(slug: string): Promise<CatalogFeature | null>;
  upsertFeature(data: Partial<CatalogFeature> & { slug: string }): Promise<CatalogFeature>;
  deleteFeature(slug: string): Promise<void>;

  // Audits
  insertAudit(slug: string, audit: Omit<AuditResult, 'id'>): Promise<StoredAudit>;
  getAudits(slug: string): Promise<StoredAudit[]>;

  // Issues
  insertIssue(slug: string, issue: Omit<KnownIssue, 'id'>): Promise<StoredIssue>;
  resolveIssue(issueId: string): Promise<void>;
  getOpenIssues(slug?: string): Promise<StoredIssue[]>;

  // Improvements
  insertImprovement(slug: string, entry: Omit<ImprovementEntry, 'id'>): Promise<StoredImprovement>;
  getImprovements(slug: string): Promise<StoredImprovement[]>;
}
