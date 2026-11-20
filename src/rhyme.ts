/* Lightweight, offline English heuristics: syllables per line and end-rhyme families. Approximate by design. */

const VOWELS = "aeiouy";

export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = w.match(/[aeiouy]{1,2}/g);
  let n = groups ? groups.length : 1;
  if (/[^aeiouy]le$/.test(word.toLowerCase())) n++;
  return Math.max(1, n);
}

export function lineSyllables(line: string): number {
  return line
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .reduce((sum, w) => sum + (/^\d+$/.test(w) ? numberSyllables(w) : syllables(w)), 0);
}

function numberSyllables(n: string): number {
  return Math.max(1, Math.round(n.length * 1.5)); // rough: "24" ~ twen-ty-four
}

/** A rough sound key for the end of a word: its last vowel sound plus a simplified ending consonant. */
export function rhymeKey(word: string): string | null {
  const raw = word.toLowerCase().replace(/[^a-z']/g, "");
  let w = raw.replace(/in'$/, "ing").replace(/'/g, "");
  if (w.length < 2) return null;
  const onlyVowelIsY = !/[aeiou]/.test(w);
  w = w
    .replace(/igh/g, "I")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/([^aeiou])ey$/, "$1E") // money, honey
    .replace(/([^aeiou])y$/, onlyVowelIsY ? "$1I" : "$1E") // fly vs. happy
    .replace(/^([^aeiou]+)([oe])$/, (_, c, v) => c + longVowel(v)) // go, me
    .replace(/([aeiou])([^aeiou]+)e$/, (_, v, c) => `${longVowel(v)}${c}`) // magic e: time, game
    .replace(/ee|ea|ie(?=.)/g, "E")
    .replace(/ai|ay|ei|ey/g, "A")
    .replace(/oa|ow(?=[^aeiou]|$)|oe/g, "O")
    .replace(/oo|ew|ue/g, "U")
    .replace(/ou/g, "W")
    .replace(/s$/, "")
    .replace(/z$/, "");
  const m = w.match(/[aeiouyAEIOUW]+[^aeiouyAEIOUW]*$/);
  if (!m) return null;
  let key = m[0].replace(/(.)\1+/g, "$1");
  // Slant rhymes: treat similar-sounding endings as one family.
  key = key
    .replace(/ng$|nk$/, "N")
    .replace(/[mn]$/, "N")
    .replace(/[td]$/, "T")
    .replace(/[pb]$/, "P")
    .replace(/[kg]$/, "K")
    .replace(/[fv]$/, "F");
  return key;
}

function longVowel(v: string) {
  return ({ a: "A", e: "E", i: "I", o: "O", u: "U" } as Record<string, string>)[v] ?? v;
}

export interface LineInfo {
  syllables: number;
  /** Rhyme-scheme letter (A, B, C…) or null when the line's ending rhymes with nothing nearby. */
  letter: string | null;
  colorIndex: number;
}

/** Scheme letters for each line's last word. Lines only get a letter if at least two share it. */
export function analyze(lines: string[]): LineInfo[] {
  const keys = lines.map((l) => {
    const words = l.trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
    return words.length ? rhymeKey(words[words.length - 1]) : null;
  });
  const counts = new Map<string, number>();
  keys.forEach((k) => k && counts.set(k, (counts.get(k) || 0) + 1));
  const letters = new Map<string, number>();
  return lines.map((l, i) => {
    const k = keys[i];
    let letter: string | null = null;
    let colorIndex = -1;
    if (k && (counts.get(k) || 0) > 1) {
      if (!letters.has(k)) letters.set(k, letters.size);
      colorIndex = letters.get(k)!;
      letter = String.fromCharCode(65 + (colorIndex % 26));
    }
    return { syllables: l.trim() ? lineSyllables(l) : 0, letter, colorIndex };
  });
}
