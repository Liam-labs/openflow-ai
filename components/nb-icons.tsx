// Icons for the chat navbar: the Midnight Glass kit's 16px stroke set (data/design-kits/midnight-glass/js/chat-navbar.js),
// plus up / down / close for the inline search, drawn in the same style.
import React from 'react';

const PATHS = {
  hash: "<path d=\"M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.5 6h11M2.5 10h11\"/>",
  gear: "<circle cx=\"8\" cy=\"8\" r=\"2.2\"/><path d=\"M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1\"/>",
  sliders: "<path d=\"M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6\"/><circle cx=\"10\" cy=\"5\" r=\"1.5\"/><circle cx=\"6\" cy=\"11\" r=\"1.5\"/>",
  chat: "<path d=\"M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5V11h-.5a1 1 0 0 1-1-1z\"/>",
  sprint: "<path d=\"M9 1.8 3.8 9h3.7L7 14.2 12.2 7H8.5z\"/>",
  teams: "<circle cx=\"6\" cy=\"5.5\" r=\"2.3\"/><path d=\"M1.8 13c.3-2.4 2-3.7 4.2-3.7s3.9 1.3 4.2 3.7M10.5 3.5a2.2 2.2 0 0 1 0 4.2M12 9.6c1.2.5 2 1.6 2.2 3.4\"/>",
  idea: "<path d=\"M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.7.9.7 1.5v.4h3.4v-.4c0-.6.2-1.1.7-1.5A4.2 4.2 0 0 0 8 1.8zM6.4 13.4h3.2\"/>",
  search: "<circle cx=\"7\" cy=\"7\" r=\"4.5\"/><path d=\"m10.5 10.5 3 3\"/>",
  at: "<circle cx=\"8\" cy=\"8\" r=\"2.3\"/><path d=\"M10.3 8v1a1.7 1.7 0 0 0 3.4 0V8a5.7 5.7 0 1 0-2.3 4.6\"/>",
  people: "<circle cx=\"8\" cy=\"5.5\" r=\"2.4\"/><path d=\"M3 13.5c.4-2.5 2.4-4 5-4s4.6 1.5 5 4\"/>",
  doc: "<path d=\"M4 1.8h5l3 3v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM9 1.8v3h3M5.5 8h5M5.5 10.5h5\"/>",
  ops: "<rect x=\"2\" y=\"2.5\" width=\"12\" height=\"4.5\" rx=\"1.2\"/><rect x=\"2\" y=\"9\" width=\"12\" height=\"4.5\" rx=\"1.2\"/><path d=\"M4.5 4.7h.01M4.5 11.2h.01\"/>",
  panel: "<rect x=\"2\" y=\"3\" width=\"12\" height=\"10\" rx=\"1.6\"/><path d=\"M6 3v10\"/>",
  menu: "<path d=\"M2.5 4.5h11M2.5 8h11M2.5 11.5h11\"/>",
  pin: "<path d=\"M9.5 2.5l4 4-2 .8-2.4 2.6.2 2.6-1 1-2.8-2.8-3.5 3.5M6.2 6.2l3.6 3.6\"/>",
  vol: "<path d=\"M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5zM10.5 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8\"/>",
  mute: "<path d=\"M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5zM10.8 6l3.2 4M14 6l-3.2 4\"/>",
  spell: "<path d=\"M3 12 6 3.5 9 12M4 9.5h4M10.5 8.5l1.5 1.5 2.5-3\"/>",
  stop: "<rect x=\"4\" y=\"4\" width=\"8\" height=\"8\" rx=\"1.5\"/>",
  check: "<path d=\"m3.5 8.5 3 3 6-6.5\"/>",
  up: "<path d=\"m4 10 4-4 4 4\"/>",
  down: "<path d=\"m4 6 4 4 4-4\"/>",
  dots: "<circle cx=\"3.5\" cy=\"8\" r=\".6\"/><circle cx=\"8\" cy=\"8\" r=\".6\"/><circle cx=\"12.5\" cy=\"8\" r=\".6\"/>",
  close: "<path d=\"m4 4 8 8M12 4l-8 8\"/>",
} as const;

export type NbIconName = keyof typeof PATHS;

export function NbIcon({ name, size = 16 }: { name: NbIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: PATHS[name] }} />
  );
}
