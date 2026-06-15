import db from '../database';

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function containsBannedWord(content: string): string | null {
  const rows = db.prepare('SELECT word FROM banned_words').all() as { word: string }[];
  for (const row of rows) {
    if (content.includes(row.word)) {
      return row.word;
    }
  }
  return null;
}

export function maskContent(content: string): string {
  const rows = db.prepare('SELECT word FROM banned_words').all() as { word: string }[];
  let result = content;
  for (const row of rows) {
    const regex = new RegExp(escapeRegExp(row.word), 'g');
    result = result.replace(regex, '*'.repeat(row.word.length));
  }
  return result;
}
