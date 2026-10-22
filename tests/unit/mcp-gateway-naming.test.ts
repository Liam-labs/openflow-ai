import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('model-neutral DevFlow MCP Gateway naming', () => {
  it('uses the canonical product name and model-neutral contract in the panel', () => {
    const source = readFileSync(
      join(root, 'components/systems/MCPServersSection.tsx'),
      'utf8',
    );

    expect(source).toContain('Model-neutral DevFlow MCP Gateway');
    expect(source).toContain('One shared capability contract for every AgentChat runtime');
  });

  it('labels Systems navigation as MCP Gateway', () => {
    const sidebar = readFileSync(
      join(root, 'components/systems/SystemsSidebar.tsx'),
      'utf8',
    );
    const labels = readFileSync(
      join(root, 'components/systems/systems-types.ts'),
      'utf8',
    );

    expect(sidebar).toContain("label: 'MCP Gateway'");
    expect(labels).toContain("mcp: 'MCP Gateway'");
  });

  it('backs the panel name with a real shared service and capability contract', () => {
    const service = readFileSync(
      join(root, 'services/devflow-mcp-gateway/src/gateway-service.ts'),
      'utf8',
    );
    const ecosystem = readFileSync(join(root, 'ecosystem.config.js'), 'utf8');

    expect(service).toContain("'design_session_create'");
    expect(service).toContain("'design_session_feedback'");
    expect(service).toContain("'design_session_export'");
    expect(ecosystem).toContain("name: 'devflow-mcp-gateway'");
    expect(ecosystem).toContain("DEVFLOW_GATEWAY_HOST: '127.0.0.1'");
  });
});
