/**
 * synthesis-check.ts — Hermes Sprint T3 synthesis gate runner.
 *
 * Called by flush.sh synthesis_gate() at session end. Reads the current
 * session transcript, runs trigger analysis, and writes a synthesis
 * suggestion to the pending file if triggered.
 *
 * Usage: npx tsx synthesis-check.ts <transcript-path> <pending-output-path>
 * Exit 0 — always (errors handled gracefully, never block session end).
 */

import * as fs from 'fs';
import { analyzeTranscript } from '../../lib/skill-synthesis-trigger';

const transcriptPath = process.argv[2];
const outputPath = process.argv[3];

if (!transcriptPath || !outputPath) {
  console.error('Usage: synthesis-check.ts <transcript-path> <pending-output-path>');
  process.exit(0);
}

try {
  const result = analyzeTranscript(transcriptPath);

  if (result.triggered && result.suggestion) {
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, result.suggestion);

    console.log(
      `synthesis triggered: toolCount=${result.toolCount} ` +
      `reasons=${result.reasons.join(',')} ` +
      `wrote=${outputPath}`,
    );
  } else {
    console.log(
      `synthesis not triggered: toolCount=${result.toolCount} ` +
      `errorCount=${result.errorCount}`,
    );
  }
} catch (err) {
  console.error(`synthesis-check error (non-blocking): ${err}`);
}

process.exit(0);
