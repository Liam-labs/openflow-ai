import { NextRequest, NextResponse } from 'next/server';
import { getProjectById } from '@/lib/config';
import { scanDirectory, redactSecret } from '@/lib/scanner/engine';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const POST = tracked('/api/scan', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;

  try {
    const body = await request.json();
    const { projectId, redact = true } = body as { projectId: string; redact?: boolean };

    if (!projectId) {
      return NextResponse.json({ success: false, error: 'Project ID required' }, { status: 400 });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    // Run scan with timeout protection
    const timeoutMs = 30000; // 30 second timeout
    const scanPromise = scanDirectory(project.path, project.id);

    const result = await Promise.race([
      scanPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Scan timeout')), timeoutMs)
      )
    ]);

    // Make paths relative and optionally redact secrets
    const relativeFindings = result.findings.map(f => ({
      ...f,
      file: f.file.replace(project.path, ''),
      match: redact ? redactSecret(f.match) : f.match,
      snippet: redact
        ? f.snippet.replace(f.match, redactSecret(f.match))
        : f.snippet
    }));

    return NextResponse.json({
      projectId,
      projectName: project.name,
      findings: relativeFindings,
      filesScanned: result.filesScanned,
      duration: result.duration,
      timestamp: result.timestamp,
      summary: {
        total: relativeFindings.length,
        critical: relativeFindings.filter(f => f.severity === 'critical').length,
        high: relativeFindings.filter(f => f.severity === 'high').length,
        medium: relativeFindings.filter(f => f.severity === 'medium').length,
        low: relativeFindings.filter(f => f.severity === 'low').length,
      }
    });

  } catch (error) {
    console.error('Scan error:', error);
    const message = error instanceof Error ? error.message : 'Failed to complete scan';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
});
