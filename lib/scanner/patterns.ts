import { SecretPattern, SecretFinding } from '@/lib/types';

export type { SecretPattern, SecretFinding };

// High-signal regex patterns for secret detection
export const SECRET_PATTERNS: SecretPattern[] = [
  // Critical - Production API Keys
  {
    name: 'AWS Access Key',
    pattern: /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
    description: 'AWS Access Key ID',
    severity: 'critical'
  },
  {
    name: 'AWS Secret Key',
    pattern: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/,
    description: 'Potential AWS Secret Access Key',
    severity: 'critical'
  },
  {
    name: 'Stripe Live Key',
    pattern: /(sk_live_|rk_live_)[0-9a-zA-Z]{24,}/,
    description: 'Stripe Live API Key',
    severity: 'critical'
  },
  {
    name: 'Private Key Block',
    pattern: /-----BEGIN ((EC|PGP|DSA|RSA|OPENSSH) )?PRIVATE KEY( BLOCK)?-----/,
    description: 'Private Key file content',
    severity: 'critical'
  },
  {
    name: 'GitHub Token',
    pattern: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/,
    description: 'GitHub Personal Access Token',
    severity: 'critical'
  },
  {
    name: 'GitLab Token',
    pattern: /glpat-[a-zA-Z0-9\-_]{20,}/,
    description: 'GitLab Personal Access Token',
    severity: 'critical'
  },

  // High - Service Tokens
  {
    name: 'Slack Token',
    pattern: /xox[baprs]-([0-9a-zA-Z]{10,48})/,
    description: 'Slack API Token',
    severity: 'high'
  },
  {
    name: 'Google API Key',
    pattern: /AIza[0-9A-Za-z\-_]{35}/,
    description: 'Google API Key',
    severity: 'high'
  },
  {
    name: 'Anthropic API Key',
    pattern: /sk-ant-api[0-9a-zA-Z\-_]{32,}/,
    description: 'Anthropic API Key',
    severity: 'critical'
  },
  {
    name: 'OpenAI API Key',
    pattern: /sk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/,
    description: 'OpenAI API Key',
    severity: 'critical'
  },
  {
    name: 'Sendgrid API Key',
    pattern: /SG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}/,
    description: 'Sendgrid API Key',
    severity: 'high'
  },
  {
    name: 'Twilio API Key',
    pattern: /SK[a-f0-9]{32}/,
    description: 'Twilio API Key SID',
    severity: 'high'
  },
  {
    name: 'Mailchimp API Key',
    pattern: /[a-f0-9]{32}-us[0-9]{1,2}/,
    description: 'Mailchimp API Key',
    severity: 'high'
  },
  {
    name: 'NPM Token',
    pattern: /npm_[a-zA-Z0-9]{36}/,
    description: 'NPM Access Token',
    severity: 'high'
  },
  {
    name: 'Discord Token',
    pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/,
    description: 'Discord Bot Token',
    severity: 'high'
  },
  {
    name: 'Heroku API Key',
    pattern: /[h|H]eroku[a-zA-Z0-9\-_]*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/,
    description: 'Heroku API Key',
    severity: 'high'
  },

  // Medium - Generic Patterns
  {
    name: 'Generic API Key',
    pattern: /['"]?api[_-]?key['"]?\s*[:=]\s*['"]([A-Za-z0-9_\-]{20,})['"]/i,
    description: 'Generic API Key assignment',
    severity: 'medium'
  },
  {
    name: 'Generic Secret',
    pattern: /['"]?secret['"]?\s*[:=]\s*['"]([A-Za-z0-9_\-]{20,})['"]/i,
    description: 'Generic secret assignment',
    severity: 'medium'
  },
  {
    name: 'Password Assignment',
    pattern: /['"]?password['"]?\s*[:=]\s*['"]([^'"]{8,})['"]/i,
    description: 'Hardcoded password',
    severity: 'medium'
  },
  {
    name: 'Bearer Token',
    pattern: /Bearer\s+[a-zA-Z0-9\-\._~\+\/]+=*/,
    description: 'Authorization Bearer Token',
    severity: 'medium'
  },
  {
    name: 'Basic Auth',
    pattern: /Basic\s+[a-zA-Z0-9+\/=]{20,}/,
    description: 'Basic Auth credentials',
    severity: 'medium'
  },
  {
    name: 'JWT Token',
    pattern: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/,
    description: 'JSON Web Token',
    severity: 'medium'
  },

  // Database - High risk
  {
    name: 'Connection String',
    pattern: /(mongodb|mysql|postgres|redis):\/\/[^:]+:[^@]+@[^\s'"]+/i,
    description: 'Database connection string with credentials',
    severity: 'high'
  },

  // Low - Test keys (still worth flagging)
  {
    name: 'Stripe Test Key',
    pattern: /(sk_test_|pk_test_)[0-9a-zA-Z]{24,}/,
    description: 'Stripe Test API Key (still sensitive)',
    severity: 'low'
  },
];

// Files and folders to skip for performance
export const IGNORED_PATHS = [
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'coverage',
  '.DS_Store',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'target',
  'vendor',
  'packages',
  '.yarn',
  '.pnpm-store',
];

export const IGNORED_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
];

export const IGNORED_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.avif',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a',
  '.pyc', '.pyo', '.class', '.jar',
  '.min.js', '.min.css', '.map',
];
