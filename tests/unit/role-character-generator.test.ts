import { describe, expect, it } from 'vitest';
import { buildCharacterPrompt, parseGeneratedCharacter } from '@/lib/role-character-generator';

const md = (name: string) =>
  `# Personality: ${name}\n\nYou are ${name} from The Sandman.\n\n` + 'Shapes worlds with care and precision. '.repeat(8);

describe('parseGeneratedCharacter', () => {
  it('accepts a well-formed character', () => {
    const out = parseGeneratedCharacter(JSON.stringify({ name: 'Morpheus', source: 'The Sandman', markdown: md('Morpheus') }), ['Carol']);
    expect(out?.name).toBe('Morpheus');
    expect(out?.markdown.endsWith('\n')).toBe(true);
  });

  it('accepts a fenced JSON reply and hyphenated names', () => {
    const raw = '```json\n' + JSON.stringify({ name: 'Obi-Wan', source: 'Star Wars', markdown: md('Obi-Wan') }) + '\n```';
    expect(parseGeneratedCharacter(raw, [])?.name).toBe('Obi-Wan');
  });

  it('rejects taken names case-insensitively', () => {
    expect(parseGeneratedCharacter(JSON.stringify({ name: 'Carol', source: 'SG-1', markdown: md('Carol') }), ['carol'])).toBeNull();
  });

  it('rejects unsafe names, a wrong title and non-JSON', () => {
    expect(parseGeneratedCharacter(JSON.stringify({ name: '../etc', source: 'x', markdown: md('x') }), [])).toBeNull();
    expect(parseGeneratedCharacter(JSON.stringify({ name: 'Two Words', source: 'x', markdown: md('Two Words') }), [])).toBeNull();
    expect(parseGeneratedCharacter(JSON.stringify({ name: 'Dream', source: 'x', markdown: md('Morpheus') }), [])).toBeNull();
    expect(parseGeneratedCharacter('not json', [])).toBeNull();
  });
});

describe('buildCharacterPrompt', () => {
  it('names the role and every taken name', () => {
    const prompt = buildCharacterPrompt({ name: '3D Animator', description: 'Blender assets' }, ['Carol', 'Zelenka']);
    expect(prompt).toContain('Role: 3D Animator. Blender assets');
    expect(prompt).toContain('Do NOT use any of these names: Carol, Zelenka.');
  });
});
