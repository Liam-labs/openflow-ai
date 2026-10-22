import { defineConfig } from 'vitest/config';
import path from 'path';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  // tsconfig.json excludes tests/ to keep `next build` lean, so the
  // tsconfig-paths plugin no longer maps `@/` for test files.
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
  test: {
    environment: 'node',
    globals: true,
    // The tests were written with this owner name and Windows profile; step 3 of the open-source cleanup moves them to the constant.
    env: { NEXT_PUBLIC_DEVFLOW_OWNER_NAME: 'Owner', DEVFLOW_WINDOWS_HOME: '/mnt/c/Users/winuser' },
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/computer-use/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
    },
  },
});
