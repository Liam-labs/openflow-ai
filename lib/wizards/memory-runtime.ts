/** Container-only Qdrant. No Docker socket, host mounts or public listener. */
import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, openSync, closeSync } from 'fs';
import path from 'path';

const runtime = globalThis as typeof globalThis & { __openflowQdrant?: ChildProcess; __openflowQdrantStart?: Promise<void> };

export function managedDatabase(root: string) {
  return {
    async start(): Promise<void> {
      if (runtime.__openflowQdrant && runtime.__openflowQdrant.exitCode === null) return;
      if (runtime.__openflowQdrantStart) return runtime.__openflowQdrantStart;
      const start = async () => {
      const storage = path.join(root, 'qdrant-storage');
      await fs.mkdir(storage, { recursive: true, mode: 0o700 });
      const log = openSync(path.join(root, 'qdrant-runtime.log'), 'a', 0o600);
      let child: ChildProcess;
      try {
        child = spawn('/usr/local/bin/openflow-qdrant', [], {
          cwd: root,
          env: { ...process.env, QDRANT__SERVICE__HOST: '127.0.0.1', QDRANT__SERVICE__HTTP_PORT: '6333',
            QDRANT__SERVICE__GRPC_PORT: '6334', QDRANT__STORAGE__STORAGE_PATH: storage,
            QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(storage, 'snapshots'), QDRANT__TELEMETRY_DISABLED: 'true' },
          stdio: ['ignore', log, log],
        });
      } finally { closeSync(log); }
      runtime.__openflowQdrant = child;
      child.once('exit', () => { if (runtime.__openflowQdrant === child) delete runtime.__openflowQdrant; });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', (error) => {
          if (runtime.__openflowQdrant === child) delete runtime.__openflowQdrant;
          reject(error);
        });
      });
      };
      runtime.__openflowQdrantStart = start();
      try { await runtime.__openflowQdrantStart; } finally { delete runtime.__openflowQdrantStart; }
    },
    async stop(): Promise<void> {
      await runtime.__openflowQdrantStart;
      const child = runtime.__openflowQdrant;
      if (!child || child.exitCode !== null) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
        const done = () => { clearTimeout(timer); resolve(); };
        child.once('exit', done);
        if (!child.kill('SIGTERM')) { clearTimeout(timer); child.off('exit', done); reject(new Error('Could not stop the memory database')); }
      });
    },
  };
}

export async function restoreManagedMemory(): Promise<void> {
  if (process.env.OPENFLOW_MANAGED_QDRANT !== '1') return;
  const { realDeps } = await import('./memory');
  const d = await realDeps();
  const record = await d.readRecord();
  if (record.enabled && !record.adopted) await d.database?.start();
}
