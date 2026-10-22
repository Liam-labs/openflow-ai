import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('frontend quality scaffolding', () => {
  const frontendRole = read('data/roles/frontend-dev.md');
  const designerRole = read('data/roles/designer.md');
  const referenceDiscovery = read(
    'data/skills/design-reference-discovery/SKILL.md',
  );
  const artDirectedFrontend = read(
    'data/skills/art-directed-frontend/SKILL.md',
  );
  const aesthetics = read('data/skills/frontend-aesthetics/SKILL.md');
  const visualAssets = read('data/skills/visual-assets/SKILL.md');
  const visualReview = read('data/skills/visual-review/SKILL.md');
  const skillIndex = read('data/scaffolding/masters/global/skill-index.md');
  const skillMatrix = JSON.parse(read('data/skills/matrix.json')) as {
    skillCount: number;
    skills: Array<{ name: string; skillFile: string }>;
  };
  const router = read(
    'data/scaffolding/masters/global/frontend-aesthetics-block.md',
  );

  it('keeps frontend roles compact and routes procedure to owning skills', () => {
    for (const skill of [
      '/design-reference-discovery',
      '/art-directed-frontend',
      '/frontend-aesthetics',
      '/visual-assets',
      '/visual-review',
    ]) {
      expect(frontendRole).toContain(skill);
      expect(designerRole).toContain(skill);
    }

    expect(frontendRole.split('\n').length).toBeLessThanOrEqual(55);
    expect(designerRole.split('\n').length).toBeLessThanOrEqual(45);

    for (const duplicatedDetail of [
      'Anime.js',
      'Kokonut UI',
      'Bklit UI',
      'Inter, Poppins, Roboto, Montserrat',
      'Page rhythm map',
      'Section composition map',
      'Every dimension must reach',
    ]) {
      expect(frontendRole).not.toContain(duplicatedDetail);
      expect(designerRole).not.toContain(duplicatedDetail);
    }
  });

  it('gates only genuinely blank-slate direction selection', () => {
    expect(router).toContain('applies only to genuinely blank-slate visual work');
    expect(router).toContain('existing brand, design system');
    expect(router).toContain('project-approved direction wins');
    expect(router).toContain('awaiting-selection');
    expect(router).toContain('blocks only the gated visual mutation');

    expect(referenceDiscovery).toContain('the task is a material new frontend direction');
    expect(referenceDiscovery).toContain('the project has no approved visual direction');
    expect(referenceDiscovery).toContain('Skip it for:');
    expect(referenceDiscovery).toContain('extension of an established design system');
    expect(referenceDiscovery).toContain('Pending-selection mutation gate');
    expect(referenceDiscovery).toContain('server-issued selection fingerprint');
    expect(referenceDiscovery).toContain('do not edit or create product source files');

    for (const role of [frontendRole, designerRole]) {
      expect(role).toContain('existing');
      expect(role).toMatch(/win/);
      expect(role).not.toContain("obtain Owner's");
      expect(role).not.toContain('explicit approval from Owner');
    }
  });

  it('keeps design detail in skills without overriding an approved project system', () => {
    expect(aesthetics).toContain("project's existing brand, design system");
    expect(aesthetics).toContain('explicitly\napproved direction first');
    expect(aesthetics).toContain('genuinely blank-slate work');
    expect(aesthetics).not.toContain('The only approved primary UI font families');
    expect(aesthetics).not.toContain('explicit approval from Owner');

    expect(artDirectedFrontend).toContain('Page rhythm map');
    expect(artDirectedFrontend).toContain('Section composition map');
    expect(artDirectedFrontend).toContain('Independent review');
    expect(visualAssets).toContain('provenance');
    expect(visualReview).toContain('independent art-direction review');
    expect(visualReview).toContain('4/5');
  });

  it('preserves accessibility and rendered-evidence ownership', () => {
    for (const required of [
      'semantic',
      'keyboard-usable',
      'visible focus',
      'reduced-motion',
      'WCAG 2.2 AA',
      'Render and use the changed flow',
      'inspect the evidence',
    ]) {
      expect(frontendRole).toContain(required);
    }

    expect(designerRole).toContain('honest provenance');
    expect(designerRole).toContain('rendered experience');
    expect(designerRole).toContain('accessibility');
  });

  it('discovers the changing skill set from the generated catalog', () => {
    const names = new Set(skillMatrix.skills.map((skill) => skill.name));
    const onDiskCount = fs
      .readdirSync(path.join(root, 'data/skills'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(root, 'data/skills', entry.name, 'SKILL.md')),
      ).length;

    for (const name of [
      'design-reference-discovery',
      'art-directed-frontend',
      'frontend-aesthetics',
      'visual-assets',
      'visual-review',
    ]) {
      expect(names.has(name)).toBe(true);
    }

    expect(skillMatrix.skillCount).toBe(onDiskCount);
    expect(skillIndex).toContain('data/skills/matrix.json');
    expect(skillIndex).toContain('generated rather than hand-editing');
    expect(skillIndex).not.toContain('| Skill | Trigger |');
  });
});
