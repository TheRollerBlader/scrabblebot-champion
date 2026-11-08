import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const LETTER_VALUES: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1,
  J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1,
  S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export const LETTER_VALUES_ARRAY = new Int32Array([
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3,
  1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]);

export function getLengthMultiplier(length: number): number {
  if (length <= 3) return 1.0;
  if (length === 4) return 1.5;
  if (length === 5) return 2.0;
  if (length === 6) return 2.5;
  return 3.0; // 7+ letters
}

export function calculateWordScore(word: string): number {
  const cleanWord = word.toUpperCase();
  let baseScore = 0;
  for (let i = 0; i < cleanWord.length; i++) {
    baseScore += LETTER_VALUES[cleanWord[i]!] || 0;
  }
  const multiplier = getLengthMultiplier(cleanWord.length);
  return Math.floor(baseScore * multiplier);
}

/**
 * Pre-indexed word entry stored as a 26-element byte array histogram
 * and 26-bit presence bitmask for sub-millisecond candidate retrieval.
 */
export interface IndexedWord {
  readonly word: string;
  readonly length: number;
  readonly baseScore: number;
  readonly score: number;
  readonly mask: number;
  readonly histogram: Uint8Array;
  readonly signature: string;
}

/**
 * Compact anagram group (all anagrams share identical tile requirements and score).
 */
export interface AnagramGroup {
  readonly bestWord: string;
  readonly words: string[];
  readonly length: number;
  readonly score: number;
  readonly mask: number;
  readonly histogram: Uint8Array;
  readonly signature: string;
}

export class FastDictionaryEngine {
  readonly wordCount: number;
  readonly anagramCount: number;
  readonly loadTimeMs: number;
  readonly allWords: readonly IndexedWord[];
  readonly anagramGroups: readonly AnagramGroup[];
  readonly bySignature: ReadonlyMap<string, AnagramGroup>;
  /** High-efficiency yield (6L 2.5x) and Bingo (7-8L 3.0x) groups sorted by score desc */
  readonly bingoAndHighYieldStems: readonly AnagramGroup[];
  private readonly wordSet: ReadonlySet<string>;

  constructor(wordsInput?: readonly string[]) {
    const t0 = performance.now();
    const rawWords = wordsInput ?? FastDictionaryEngine.loadDefaultWordlist();

    const wordSet = new Set<string>();
    const allWords: IndexedWord[] = [];
    const bySignature = new Map<string, AnagramGroup>();

    for (let wIdx = 0; wIdx < rawWords.length; wIdx++) {
      const raw = rawWords[wIdx]!;
      const upper = raw.trim().toUpperCase();
      if (upper.length < 2) continue;

      let valid = true;
      let mask = 0;
      let baseScore = 0;
      const hist = new Uint8Array(26);

      for (let i = 0; i < upper.length; i++) {
        const code = upper.charCodeAt(i) - 65;
        if (code < 0 || code >= 26) {
          valid = false;
          break;
        }
        hist[code]!++;
        mask |= 1 << code;
        baseScore += LETTER_VALUES_ARRAY[code]!;
      }
      if (!valid || wordSet.has(upper)) continue;
      wordSet.add(upper);

      const mult = getLengthMultiplier(upper.length);
      const score = Math.floor(baseScore * mult);
      const signature = histogramToSignature(hist);

      const entry: IndexedWord = {
        word: upper,
        length: upper.length,
        baseScore,
        score,
        mask,
        histogram: hist,
        signature,
      };
      allWords.push(entry);

      const existing = bySignature.get(signature);
      if (existing) {
        existing.words.push(upper);
      } else {
        bySignature.set(signature, {
          bestWord: upper,
          words: [upper],
          length: upper.length,
          score,
          mask,
          histogram: hist,
          signature,
        });
      }
    }

    // Sort anagram groups by score descending, then length descending
    const anagramGroups = Array.from(bySignature.values()).sort(
      (a, b) => b.score - a.score || b.length - a.length || (a.bestWord < b.bestWord ? -1 : 1)
    );

    // Pre-filter top 5..8 letter stems for fast 1-tile and 2-tile completion valuation
    const bingoAndHighYieldStems = anagramGroups.filter(
      (g) => g.length >= 5 && g.length <= 8 && g.score >= 16
    );

    this.wordCount = allWords.length;
    this.anagramCount = anagramGroups.length;
    this.allWords = allWords;
    this.anagramGroups = anagramGroups;
    this.bySignature = bySignature;
    this.bingoAndHighYieldStems = bingoAndHighYieldStems;
    this.wordSet = wordSet;
    this.loadTimeMs = +(performance.now() - t0).toFixed(2);
  }

  static loadDefaultWordlist(): string[] {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(dir, "..", "ENABLE.txt"),
      path.resolve(dir, "..", "data", "wordlist.txt"),
      path.resolve(process.cwd(), "ENABLE.txt"),
      path.resolve(process.cwd(), "data", "wordlist.txt"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, "utf8").split(/\r?\n/);
      }
    }
    throw new Error("ENABLE.txt / wordlist.txt not found in workspace!");
  }

  isValidWord(word: string): boolean {
    return this.wordSet.has(word.trim().toUpperCase());
  }

  /**
   * Sub-millisecond playable word lookup using subset signature enumeration for racks <= 11 tiles
   * and bitwise superset mask + histogram frequency verification for larger racks.
   */
  findPlayableGroups(rackHist: Uint8Array, rackMask: number, totalTiles: number): AnagramGroup[] {
    if (totalTiles < 2) return [];

    // For racks up to 11 tiles (2^11 = 2048 subsets), subset signature lookup is < 0.4ms!
    if (totalTiles <= 11) {
      const tiles: number[] = [];
      for (let i = 0; i < 26; i++) {
        const count = rackHist[i]!;
        for (let k = 0; k < count; k++) tiles.push(i);
      }
      const n = tiles.length;
      const limit = 1 << n;
      const seen = new Set<string>();
      const groups: AnagramGroup[] = [];
      const tempCounts = new Uint8Array(26);

      for (let subset = 3; subset < limit; subset++) {
        // Must have at least 2 bits set
        if ((subset & (subset - 1)) === 0) continue;
        tempCounts.fill(0);
        for (let b = 0; b < n; b++) {
          if ((subset & (1 << b)) !== 0) {
            tempCounts[tiles[b]!]!++;
          }
        }
        const sig = histogramToSignature(tempCounts);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const group = this.bySignature.get(sig);
        if (group !== undefined) {
          groups.push(group);
        }
      }
      groups.sort((a, b) => b.score - a.score || b.length - a.length);
      return groups;
    }

    // For racks >= 12 tiles, bitwise mask check + exact byte histogram comparison
    const out: AnagramGroup[] = [];
    const groups = this.anagramGroups;
    const invRackMask = ~rackMask;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (g.length > totalTiles) continue;
      // Bitwise superset check: if word has any letter bit not present in rackMask, skip immediately
      if ((g.mask & invRackMask) !== 0) continue;

      const wHist = g.histogram;
      let fits = true;
      for (let c = 0; c < 26; c++) {
        if (wHist[c]! > rackHist[c]!) {
          fits = false;
          break;
        }
      }
      if (fits) {
        out.push(g);
      }
    }
    return out;
  }

  /**
   * Returns all playable words from the rack (sorted by score desc, then length desc).
   */
  findPlayableWords(rack: readonly string[]): string[] {
    const { hist, mask, total } = rackToHistogram(rack);
    const groups = this.findPlayableGroups(hist, mask, total);
    const result: string[] = [];
    for (let i = 0; i < groups.length; i++) {
      const words = groups[i]!.words;
      for (let j = 0; j < words.length; j++) {
        result.push(words[j]!);
      }
    }
    return result;
  }
}

export function rackToHistogram(rack: readonly string[]): {
  hist: Uint8Array;
  mask: number;
  total: number;
} {
  const hist = new Uint8Array(26);
  let mask = 0;
  let total = 0;
  for (let i = 0; i < rack.length; i++) {
    const s = rack[i]!;
    if (!s) continue;
    const code = s.toUpperCase().charCodeAt(0) - 65;
    if (code >= 0 && code < 26) {
      hist[code]!++;
      mask |= 1 << code;
      total++;
    }
  }
  return { hist, mask, total };
}

export function mapToRackArray(rackMap: ReadonlyMap<string, number>): string[] {
  const out: string[] = [];
  for (const [letter, count] of rackMap.entries()) {
    const upper = letter.toUpperCase();
    for (let i = 0; i < count; i++) out.push(upper);
  }
  return out;
}

export function histogramToRackArray(hist: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) {
    const count = hist[i]!;
    if (count > 0) {
      const ch = String.fromCharCode(65 + i);
      for (let k = 0; k < count; k++) out.push(ch);
    }
  }
  return out;
}

export function histogramToSignature(hist: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 26; i++) {
    const count = hist[i]!;
    if (count === 1) {
      out += String.fromCharCode(65 + i);
    } else if (count > 1) {
      out += String.fromCharCode(65 + i).repeat(count);
    }
  }
  return out;
}

// Singleton pre-indexed dictionary loaded at startup
let GLOBAL_ENGINE: FastDictionaryEngine | null = null;

export function getGlobalDictionary(): FastDictionaryEngine {
  if (!GLOBAL_ENGINE) {
    GLOBAL_ENGINE = new FastDictionaryEngine();
  }
  return GLOBAL_ENGINE;
}
