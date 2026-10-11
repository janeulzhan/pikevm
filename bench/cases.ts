// Shared definitions for the benchmark, so the race driver, the child probe and
// the demo all describe the same work.

export interface InputSpec {
  readonly fill: string;
  readonly n: number;
  readonly suffix: string;
}

export function buildInput(spec: InputSpec): string {
  return spec.fill.repeat(spec.n) + spec.suffix;
}

export interface RedosCase {
  readonly id: string;
  readonly pattern: string;
  /** Human readable description of the input family. */
  readonly input: string;
  readonly fill: string;
  readonly suffix: string;
  readonly sizes: readonly number[];
}

/**
 * The four patterns the README races. Each one is a textbook case of
 * catastrophic backtracking: two nested quantifiers over overlapping
 * alternatives, so a backtracking engine has an exponential number of ways to
 * divide the input between them before it can conclude that nothing matches.
 */
export const REDOS_CASES: readonly RedosCase[] = [
  {
    id: "alt-nested",
    pattern: "^(a|aa)+$",
    input: '"a" * n + "b"',
    fill: "a",
    suffix: "b",
    sizes: [16, 20, 24, 28, 32, 36, 40, 48, 1000, 100000],
  },
  {
    id: "plus-nested",
    pattern: "(a+)+$",
    input: '"a" * n + "!"',
    fill: "a",
    suffix: "!",
    sizes: [16, 20, 24, 28, 32, 36, 40, 48, 1000, 100000],
  },
  {
    id: "two-plus",
    pattern: "(x+x+)+y",
    input: '"x" * n',
    fill: "x",
    suffix: "",
    sizes: [16, 20, 24, 28, 32, 36, 40, 48, 1000, 100000],
  },
  {
    id: "counted-optional",
    pattern: "^(a?){n}a{n}$",
    input: '"a" * (n - 1)',
    fill: "a",
    suffix: "",
    sizes: [14, 16, 18, 20, 22, 24, 26, 28, 30],
  },
];

/** The counted case rebuilds its pattern for each size. */
export function patternFor(c: RedosCase, n: number): string {
  if (c.id === "counted-optional") return `^(a?){${n}}a{${n}}$`;
  return c.pattern;
}

export function inputFor(c: RedosCase, n: number): InputSpec {
  if (c.id === "counted-optional") return { fill: c.fill, n: n - 1, suffix: c.suffix };
  return { fill: c.fill, n, suffix: c.suffix };
}

/**
 * Ordinary, non-pathological patterns. These exist to measure the honest cost
 * of the approach: a general NFA simulation does strictly more bookkeeping per
 * character than a backtracking engine that has been tuned for twenty years, so
 * on everyday patterns the native engine should win and the README should say
 * by how much.
 */
export const ORDINARY_CASES: readonly { id: string; pattern: string; input: InputSpec }[] = [
  { id: "literal", pattern: "needle", input: { fill: "haystack ", n: 20000, suffix: "needle" } },
  { id: "date", pattern: "(\\d{4})-(\\d{2})-(\\d{2})", input: { fill: "x", n: 20000, suffix: "2026-10-11" } },
  { id: "word-run", pattern: "^[a-z]+$", input: { fill: "q", n: 20000, suffix: "" } },
  { id: "class-scan", pattern: "[\\w.]+@[\\w]+\\.[a-z]{2,4}", input: { fill: "z", n: 20000, suffix: "jane@example.com" } },
  { id: "dot-star", pattern: "a.*b.*c", input: { fill: "d", n: 5000, suffix: "abc" } },
];

/**
 * The twelve patterns in the catastrophic-backtracking catalogue, with the
 * input size at which each one is adversarial. Timed by bench/redos.ts so the
 * README can quote a measured figure rather than a test assertion.
 */
export const CATALOGUE: readonly { pattern: string; fill: string; suffix: string; n: number }[] = [
  { pattern: "^(a|aa)+$", fill: "a", suffix: "b", n: 40 },
  { pattern: "(a+)+$", fill: "a", suffix: "!", n: 40 },
  { pattern: "(a+)+b", fill: "a", suffix: "", n: 40 },
  { pattern: "(x+x+)+y", fill: "x", suffix: "", n: 40 },
  { pattern: "(a*)*b", fill: "a", suffix: "", n: 2000 },
  { pattern: "(a|a?)+$", fill: "a", suffix: "b", n: 40 },
  { pattern: "([a-zA-Z]+)*$", fill: "a", suffix: "1", n: 40 },
  { pattern: "(a|b|ab)+c", fill: "ab", suffix: "", n: 24 },
  { pattern: "^(\\w+\\s?)*$", fill: "a", suffix: "!", n: 40 },
  { pattern: "(.*a){20}b", fill: "a", suffix: "", n: 60 },
  { pattern: "^(a?){25}a{25}$", fill: "a", suffix: "", n: 24 },
  { pattern: "((a)*)*b", fill: "a", suffix: "", n: 500 },
];
