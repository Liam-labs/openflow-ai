import { NextRequest, NextResponse } from 'next/server';
import { getSpellchecker, getDictionary, getPhoneticSuggestions } from '@/lib/spellcheck';
import { requireTokenOrLocal } from '@/lib/api-auth';
import { tracked } from '@/lib/api-tracking';

export const dynamic = 'force-dynamic';

const MAX_TEXT_LENGTH = 10_000;

export const POST = tracked('/api/spellcheck', async (request: NextRequest) => {
  const authDenied = await requireTokenOrLocal(request, 'read');
  if (authDenied) return authDenied;
  try {
    const body = await request.json();
    const { text } = body as { text: string };

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text required' }, { status: 400 });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` }, { status: 400 });
    }

    const spellchecker = await getSpellchecker();
    const dictionary = getDictionary();
    
    const words = text.split(/\s+/);
    const results = words.map(word => {
      // Skip /commands and @mentions
      if (word.startsWith('/') || word.startsWith('@')) return { word, isCorrect: true };
      const cleanWord = word.toLowerCase().replace(/[^a-z]/g, '');
      if (cleanWord.length < 3) return { word, isCorrect: true };

      const isCorrect = spellchecker.isCorrect(cleanWord);
      if (isCorrect) return { word, isCorrect: true };

      // Get standard suggestions
      const standardSuggestions = spellchecker.getCorrections(cleanWord, 2);
      
      // Get phonetic suggestions (the secret sauce for dyslexia)
      const phoneticSuggestions = getPhoneticSuggestions(cleanWord, dictionary);

      // Combine and deduplicate
      const suggestions = Array.from(new Set([...phoneticSuggestions, ...standardSuggestions])).slice(0, 5);

      return {
        word,
        isCorrect: false,
        suggestions
      };
    });

    return NextResponse.json({ results });
  } catch (error) {
    console.error('Spellcheck API error:', error);
    return NextResponse.json(
      { error: 'Failed to process spellcheck' },
      { status: 500 }
    );
  }
});
