import natural from 'natural';
import { loadDocs } from './docs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const englishWords: string[] = require('an-array-of-english-words');

let spellcheck: any = null;
let wordList: string[] = [];
let lastUpdate = 0;
const UPDATE_INTERVAL = 3600000;

const PROJECT_WORDS = [
  'devflow', 'claude', 'gemini', 'grok', 'agent', 'collab', 'sprint', 'phase',
  'dashboard', 'pm2', 'docker', 'typescript', 'react', 'nextjs', 'node', 'api',
  'webhook', 'websocket', 'middleware', 'endpoint', 'frontend', 'backend',
  'supabase', 'cloudflare', 'netlify', 'vercel', 'redis', 'postgres'
];

export async function getSpellchecker() {
  const now = Date.now();
  if (spellcheck && now - lastUpdate < UPDATE_INTERVAL) {
    return spellcheck;
  }

  const words = new Set<string>(englishWords);
  PROJECT_WORDS.forEach(w => words.add(w));

  try {
    const docs = await loadDocs();
    docs.forEach(doc => {
      const docWords = doc.content
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2);
      docWords.forEach(w => words.add(w));
    });
  } catch (error) {
    console.error('Failed to load docs for spellcheck:', error);
  }

  wordList = Array.from(words);
  // @ts-ignore
  spellcheck = new natural.Spellcheck(wordList);
  lastUpdate = now;
  return spellcheck;
}

export function getDictionary(): string[] {
  return wordList;
}

export function getPhoneticSuggestions(word: string, dictionary: string[]): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DM = (natural as any).DoubleMetaphone;
  const dm = new DM();
  const wordCode = dm.process(word);

  const matches = dictionary.filter(w => {
    const code = dm.process(w);
    return (code[0] === wordCode[0] || (code[1] && code[1] === wordCode[0]) || 
            (wordCode[1] && code[0] === wordCode[1]) || (wordCode[1] && code[1] && code[1] === wordCode[1]));
  });

  return matches
    .sort((a, b) => {
      // @ts-ignore
      return natural.LevenshteinDistance(word, a) - natural.LevenshteinDistance(word, b);
    })
    .slice(0, 5);
}
