import fs from 'fs';
import path from 'path';
import { SecretFinding, ScanResult } from '@/lib/types';
import { SECRET_PATTERNS, IGNORED_PATHS, IGNORED_FILES, IGNORED_EXTENSIONS } from './patterns';

/**
 * Calculates Shannon Entropy of a string.
 * Higher value (max 8) = more random.
 * English text is usually ~3.5-4.5.
 * API keys/Secrets are usually > 4.5 or 5.
 */
function calculateEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;

  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Redact a secret for safe display (keeps first 4 and last 4 chars)
 */
export function redactSecret(secret: string): string {
  if (secret.length <= 12) {
    return secret.slice(0, 4) + '****';
  }
  return secret.slice(0, 4) + '...' + secret.slice(-4);
}

export interface ScanStats {
  filesScanned: number;
  filesSkipped: number;
  dirsSkipped: number;
}

export async function scanDirectory(
  rootPath: string,
  projectId: string,
  onProgress?: (file: string, stats: ScanStats) => void
): Promise<ScanResult> {
  const findings: SecretFinding[] = [];
  const startTime = Date.now();
  const stats: ScanStats = {
    filesScanned: 0,
    filesSkipped: 0,
    dirsSkipped: 0
  };

  async function walk(currentPath: string) {
    let stat;
    try {
      stat = await fs.promises.stat(currentPath);
    } catch {
      return; // Can't stat, skip
    }

    if (stat.isDirectory()) {
      const dirName = path.basename(currentPath);

      // Skip ignored directories
      if (IGNORED_PATHS.includes(dirName) || dirName.startsWith('.')) {
        stats.dirsSkipped++;
        return;
      }

      try {
        const files = await fs.promises.readdir(currentPath);
        for (const file of files) {
          await walk(path.join(currentPath, file));
        }
      } catch {
        // Permission denied, etc.
      }
    } else if (stat.isFile()) {
      const fileName = path.basename(currentPath);
      const ext = path.extname(currentPath).toLowerCase();

      // Skip ignored files
      if (IGNORED_FILES.includes(fileName)) {
        stats.filesSkipped++;
        return;
      }
      if (IGNORED_EXTENSIONS.includes(ext)) {
        stats.filesSkipped++;
        return;
      }
      // Skip files > 1MB (likely binaries or minified bundles)
      if (stat.size > 1024 * 1024) {
        stats.filesSkipped++;
        return;
      }

      stats.filesScanned++;
      if (onProgress) onProgress(currentPath, stats);

      try {
        const content = await fs.promises.readFile(currentPath, 'utf-8');
        scanFile(content, currentPath, findings);
      } catch {
        // Ignore read errors (binary files, permissions)
      }
    }
  }

  await walk(rootPath);

  const duration = Date.now() - startTime;

  return {
    projectId,
    findings,
    filesScanned: stats.filesScanned,
    duration,
    timestamp: new Date().toISOString()
  };
}

function scanFile(content: string, filePath: string, findings: SecretFinding[]) {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip very long lines (minified code, base64 blobs)
    if (line.length > 1000) continue;

    for (const rule of SECRET_PATTERNS) {
      const match = rule.pattern.exec(line);
      if (match) {
        const matchedString = match[0];

        // Entropy check for generic patterns
        if (rule.name.includes('Generic') || rule.name.includes('Password')) {
          const entropy = calculateEntropy(matchedString);
          if (entropy < 3.5) continue; // Too structured, likely false positive
        }

        // False positive filters
        const lowerLine = line.toLowerCase();
        if (
          lowerLine.includes('example') ||
          lowerLine.includes('placeholder') ||
          lowerLine.includes('your_') ||
          lowerLine.includes('xxx') ||
          lowerLine.includes('test') && rule.severity !== 'low'
        ) {
          continue;
        }

        findings.push({
          ruleId: rule.name,
          description: rule.description,
          file: filePath,
          line: i + 1,
          column: match.index + 1,
          match: matchedString,
          snippet: line.trim().slice(0, 200), // Limit snippet length
          severity: rule.severity
        });
      }
    }
  }
}

/**
 * Standalone scan function for CLI usage (no DevFlow project lookup required)
 */
export async function scanPath(targetPath: string): Promise<ScanResult> {
  const absolutePath = path.resolve(targetPath);
  const projectId = path.basename(absolutePath);
  return scanDirectory(absolutePath, projectId);
}
