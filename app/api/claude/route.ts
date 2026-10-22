import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { getProjectById } from '@/lib/config';
import { requireAuthOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

export const GET = tracked('/api/claude', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'read');
  if (authDenied) return authDenied;
  return NextResponse.json({
    endpoint: '/api/claude',
    method: 'POST',
    description: 'Opens a Claude Code session in Windows Terminal for a given project',
    parameters: { projectId: 'string (required)' },
  });
});

export const POST = tracked('/api/claude', async (request: NextRequest) => {
  const authDenied = await requireAuthOrLocal(request, 'write');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { projectId } = body as { projectId: string };

    const project = await getProjectById(projectId);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const projectPath = project.path;
    const projectName = project.name;

    // Open Windows Terminal with Ubuntu profile for proper theming
    // -p "Ubuntu" uses the Ubuntu WSL profile with its configured colors/background
    // --title sets a nice tab title
    // Use interactive bash (-i) to load PATH from .bashrc
    // Note: -d flag is omitted — wt.exe -d expects a Windows path and wsl paths cause silent failure.
    // Navigation is handled by the cd command in the bash invocation instead.
    const command = `cmd.exe /c start wt.exe -p "Ubuntu" --title "Claude - ${projectName}" -- wsl.exe -e bash -ic "cd '${projectPath}' && claude --dangerously-skip-permissions"`;

    exec(command, { cwd: '/mnt/c' }, (error, stdout, stderr) => {
      if (error) {
        console.error('Error opening Claude:', error);
      }
      if (stderr) {
        console.error('stderr:', stderr);
      }
    });

    return NextResponse.json({
      success: true,
      message: `Opening Claude in ${project.name}`,
    });
  } catch (error) {
    console.error('Claude open error:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to open Claude' },
      { status: 500 }
    );
  }
});
