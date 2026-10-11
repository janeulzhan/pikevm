// Character classes as a normalised, sorted list of inclusive UTF-16 code unit
// ranges plus an optional negation flag. Normalising at construction time means
// membership is a binary search and the VM never allocates while matching.

export type Range = readonly [number, number];

export interface ClassSet {
  /** Sorted, non-overlapping, non-adjacent inclusive ranges. */
  readonly ranges: readonly Range[];
  readonly negate: boolean;
}

export function makeClass(ranges: Range[], negate: boolean): ClassSet {
  return { ranges: normalise(ranges), negate };
}

export function normalise(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  let [lo, hi] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    if (a <= hi + 1) {
      if (b > hi) hi = b;
    } else {
      out.push([lo, hi]);
      lo = a;
      hi = b;
    }
  }
  out.push([lo, hi]);
  return out;
}

export function classMatches(set: ClassSet, code: number): boolean {
  const { ranges } = set;
  let lo = 0;
  let hi = ranges.length - 1;
  let inside = false;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid];
    if (code < r[0]) hi = mid - 1;
    else if (code > r[1]) lo = mid + 1;
    else {
      inside = true;
      break;
    }
  }
  return set.negate ? !inside : inside;
}

const C = (s: string) => s.charCodeAt(0);

// ECMAScript definitions, so the differential oracle compares like with like.
export const DIGIT: Range[] = [[C("0"), C("9")]];
export const WORD: Range[] = [
  [C("0"), C("9")],
  [C("A"), C("Z")],
  [C("_"), C("_")],
  [C("a"), C("z")],
];
export const SPACE: Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

/** Line terminators, excluded by '.' because no 's' flag is supported. */
export const LINE_TERMINATORS: Range[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

export const SHORTHAND: Record<string, ClassSet> = {
  d: makeClass(DIGIT, false),
  D: makeClass(DIGIT, true),
  w: makeClass(WORD, false),
  W: makeClass(WORD, true),
  s: makeClass(SPACE, false),
  S: makeClass(SPACE, true),
};

/** '.' matches any code unit that is not a line terminator. */
export const DOT: ClassSet = makeClass(LINE_TERMINATORS, true);

export function describeClass(set: ClassSet): string {
  const body = set.ranges
    .map(([a, b]) => (a === b ? esc(a) : `${esc(a)}-${esc(b)}`))
    .join("");
  return `[${set.negate ? "^" : ""}${body}]`;
}

function esc(code: number): string {
  if (code === 0x0a) return "\\n";
  if (code === 0x0d) return "\\r";
  if (code === 0x09) return "\\t";
  if (code < 0x20 || code > 0x7e) return `\\u${code.toString(16).padStart(4, "0")}`;
  return String.fromCharCode(code);
}
