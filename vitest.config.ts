import { defineConfig } from 'vitest/config';
import os from 'os';
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
    env: {
      NEXT_PUBLIC_DEVFLOW_OWNER_NAME: 'Owner',
      DEVFLOW_WINDOWS_HOME: '/mnt/c/Users/winuser',
      // A test run must never reach a real PC or write the real bridge token: no agent host unless a test sets one, and a fixed token.
      DEVFLOW_AGENT_HOST: '',
      DEVFLOW_AGENT_USER_FILE: '/nonexistent/devflow-agent-user.json',   // never the real list of agents that run as devflow-agent
      COMPUTER_USE_BRIDGE_TOKEN: 'vitest-bridge-token-0123456789abcdefghij',
      DEVFLOW_HOME: __dirname,
      // The secret store is encrypted with a key file; a test run must never create or read the real one.
      DEVFLOW_SECRETS_KEY_FILE: path.join(os.tmpdir(), 'openflow-vitest-secrets.key'),
      // An agent's shell sets the team's real names; empty values give the code's own defaults ("Builder", "the Team Lead"...).
      DEVFLOW_BUILDER_NAME: '',
      DEVFLOW_LEAD_NAME: '',
      DEVFLOW_ARCHITECT_NAME: '',
      DEVFLOW_DESKTOP_NAME: '',
    },
    // Forget the live tmux socket so no test can reach running agents (the mass drops of 22 to 25 Oct 2026).
    setupFiles: ['tests/setup-tmux-isolation.ts'],
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/computer-use/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
    },
  },
});
