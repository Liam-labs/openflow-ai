import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('model-neutral MCP Gateway naming', () => {
  it('takes its heading and sentence from the brand file', () => {
    const source = readFileSync(
      join(root, 'components/systems/MCPServersSection.tsx'),
      'utf8',
    );

    expect(source).toContain('{MCP_PAGE_HEADING}');
    expect(source).toContain('{MCP_PAGE_SUB}');
  });

  it('takes the Systems navigation label from the brand file', () => {
    const sidebar = readFileSync(
      join(root, 'components/systems/SystemsSidebar.tsx'),
      'utf8',
    );
    const labels = readFileSync(
      join(root, 'components/systems/systems-types.ts'),
      'utf8',
    );

    expect(sidebar).toContain('label: MCP_PAGE_NAME');
    expect(labels).toContain('mcp: MCP_PAGE_NAME');
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
