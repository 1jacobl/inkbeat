/* Writing help: repeated words, random words and prompts for writer's block, and flow grid layout. */
import { syllables } from "./rhyme";

const STOP = new Set(
  "the a an and or but if then so to of in on at by for with from up down out over under is am are was were be been being i me my mine you your yours he him his she her hers it its we us our they them their this that these those what who whom which when where why how not no yes do does did done have has had will would can could should shall may might must just like got get gon gonna wanna ya yeah oh uh ooh ay hey all im i'm it's don't can't ain't i'ma you're we're they're that's there's".split(
    " "
  )
);

/** Words used `min` or more times (skipping little words like "the"). */
export function repeatedWords(text: string, min = 3): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z']+/g) ?? []) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 3 || STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= min)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * One line spread over one bar of 16 steps (sixteenth notes), the way you'd rap it evenly.
 * Each step holds a syllable (or nothing). Extra syllables past 16 are counted as overflow.
 */
export function flowRow(line: string): { cells: { text: string; start: boolean }[]; total: number; overflow: number } {
  const sylls: { text: string; start: boolean }[] = [];
  for (const w of line.split(/\s+/).filter((x) => /[a-z0-9]/i.test(x))) {
    const n = /^\d+$/.test(w) ? Math.max(1, Math.round(w.length * 1.5)) : syllables(w);
    const parts = splitWord(w.replace(/[^\w']/g, ""), n);
    parts.forEach((t, i) => sylls.push({ text: t, start: i === 0 }));
  }
  const total = sylls.length;
  const cells: { text: string; start: boolean }[] = Array.from({ length: 16 }, () => ({ text: "", start: false }));
  if (total <= 16) sylls.forEach((s, i) => (cells[Math.floor((i * 16) / Math.max(total, 1))] = s));
  else sylls.slice(0, 16).forEach((s, i) => (cells[i] = s));
  return { cells, total, overflow: Math.max(0, total - 16) };
}

/** Rough split of a word into `n` chunks for display. */
function splitWord(w: string, n: number): string[] {
  if (n <= 1 || w.length <= n) return [w];
  const out: string[] = [];
  const size = w.length / n;
  for (let i = 0; i < n; i++) out.push(w.slice(Math.round(i * size), Math.round((i + 1) * size)));
  return out;
}

export function paceLabel(total: number): string {
  if (!total) return "";
  if (total <= 6) return "laid back";
  if (total <= 10) return "steady";
  if (total <= 14) return "busy";
  if (total <= 16) return "double time";
  return "crammed";
}

const WORDS =
  "neon gravel thunder honey glass orbit velvet engine static ember river concrete mirror lantern ghost marble cipher jungle compass harbor sugar venom crown satellite rust feather avalanche silk chrome pharaoh voltage tidal skyline cathedral broken-arrow wildfire paper-plane midnight shadowbox vinyl paradox sapphire chess timber tornado scarecrow monsoon blueprint gasoline lullaby fortress quartz labyrinth comet anchor magnet ruby clockwork volcano lighthouse glacier prism rebel tiger cobra falcon ivory nickel gospel jukebox meteor oxygen pepper quicksand razor saint thorn umbrella wolf yacht zero ballot casino diesel fever galaxy hammer island jacket karma ladder mosaic novel ocean pilot riddle signal tunnel uniform vault whistle yard zodiac".split(
    " "
  );

const PROMPTS = [
  "Write about the first thing you ever bought with your own money.",
  "A letter to your younger self, but every line ends on the same vowel.",
  "Describe your city at 3am without naming it.",
  "Brag about something small like it's huge.",
  "Tell a story backwards: start with the ending.",
  "The one that got away, from their point of view.",
  "Write a hook that's only four words, repeated.",
  "Everything you'd say if the beat cut out right now.",
  "A day job you hate, written like a heist movie.",
  "Use a colour in every bar.",
  "Pick a smell from childhood and build a verse around it.",
  "Write a diss track aimed at your own bad habit.",
  "Every bar has to mention a number.",
  "Describe a breakup using only weather.",
  "You just got the call that changes everything. What do you say first?",
  "A verse where every line starts with the same letter.",
  "The most expensive thing you can't afford, and why you want it.",
  "Write the opposite of your last verse.",
  "A shout-out to someone nobody else thanks.",
  "Turn a famous saying inside out.",
  "No 'I' allowed: write the whole verse about someone else.",
  "Your phone's last five notifications, as a story.",
  "A love song to a place, not a person.",
  "Write about a promise you broke.",
];

const FLIPS = [
  "Switch to triplets for two bars.",
  "Rhyme the middle of the line, not just the end.",
  "Leave a bar of silence, then come back hard.",
  "Say the hook in a whisper the second time.",
  "Stack three internal rhymes in one bar.",
  "Start the verse on beat 2 instead of 1.",
  "Make every line exactly 12 syllables.",
  "End four bars in a row on the same word, different meanings.",
  "Answer your own line in the next bar, like a call and response.",
  "Use one long multisyllable rhyme for the whole verse.",
];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
export const randomWord = () => pick(WORDS).replace(/-/g, " ");
export const randomPrompt = () => pick(PROMPTS);
export const randomFlip = () => pick(FLIPS);
