/**
 * Supabase Instance Registry — Type Definitions
 *
 * Data model for tracking Supabase instances (local + hosted).
 * Credentials are referenced by env var name, never stored in plain text.
 */

/** Instance type — local (CLI) or hosted (Supabase cloud) */
export type SupabaseInstanceType = 'local' | 'hosted';

/** Instance health status */
export type SupabaseInstanceStatus = 'online' | 'offline' | 'unknown' | 'error';

/**
 * Connection details for a Supabase instance.
 * Credentials are stored as env var references (e.g. "SUPABASE_SECRET_KEY"),
 * never as raw values.
 */
export interface SupabaseConnectionDetails {
  /** Supabase project URL (e.g. https://xxx.supabase.co or http://localhost:54321) */
  url: string;
  /** Env var name for anon/publishable key */
  anonKeyEnvVar: string;
  /** Env var name for service role key */
  serviceRoleKeyEnvVar: string;
  /** Env var name for DB password (for direct Postgres access) */
  dbPasswordEnvVar?: string;
  /** Direct Postgres connection string env var (pooler or direct) */
  dbConnectionStringEnvVar?: string;
  /** Supabase project ID (ref) */
  projectId?: string;
}

/**
 * A registered Supabase instance
 */
export interface SupabaseInstance {
  /** Unique ID (UUID) */
  id: string;
  /** Human-readable name (e.g. "Production", "Local Dev") */
  name: string;
  /** Instance type */
  type: SupabaseInstanceType;
  /** Connection details */
  connection: SupabaseConnectionDetails;
  /** DevFlow project IDs linked to this instance */
  linkedProjects: string[];
  /** Last known status */
  status: SupabaseInstanceStatus;
  /** ISO timestamp of last health check */
  lastCheckedAt: string | null;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Optional notes */
  notes?: string;

  // ── Local instance enrichment fields ──────────────────────────────────
  /** SUPABASE_PROJECT_ID value / Docker container name suffix (local only) */
  containerRef?: string;
  /** Port assignments for local Supabase services */
  portMap?: {
    api: number;
    db: number;
    studio: number;
  };
  /** Filesystem path to the project using this Supabase instance */
  projectDirectory?: string;
  /** Shell command to start this local instance */
  startCommand?: string;
  /** Shell command to stop this local instance */
  stopCommand?: string;
}

/**
 * The JSON file structure for .AppData/supabase-instances.json
 */
export interface SupabaseInstancesFile {
  version: string;
  instances: SupabaseInstance[];
}

/**
 * Input for creating/updating an instance (omits generated fields)
 */
export interface UpsertSupabaseInstanceInput {
  id?: string;
  name: string;
  type: SupabaseInstanceType;
  connection: SupabaseConnectionDetails;
  linkedProjects?: string[];
  notes?: string;
  containerRef?: string;
  portMap?: { api: number; db: number; studio: number };
  projectDirectory?: string;
  startCommand?: string;
  stopCommand?: string;
}

/**
 * Store interface for Supabase instance registry
 */
export interface SupabaseInstanceStore {
  listInstances(): Promise<SupabaseInstance[]>;
  getInstance(id: string): Promise<SupabaseInstance | null>;
  upsertInstance(input: UpsertSupabaseInstanceInput): Promise<SupabaseInstance>;
  deleteInstance(id: string): Promise<void>;
  updateStatus(id: string, status: SupabaseInstanceStatus): Promise<void>;
  linkProject(instanceId: string, projectId: string): Promise<void>;
  unlinkProject(instanceId: string, projectId: string): Promise<void>;
}
