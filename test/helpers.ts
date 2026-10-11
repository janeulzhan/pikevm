import assert from "node:assert/strict";
import { Regex } from "../src/index.ts";

/** Asserts that `pattern` on `input` yields exactly these group slices. */
export function expectSlices(
  pattern: string,
  input: string,
  expected: (string | null)[] | null,
): void {
  const m = new Regex(pattern).exec(input);
  if (expected === null) {
    assert.equal(m, null, `/${pattern}/ should not match ${JSON.stringify(input)}`);
    return;
  }
  assert.ok(m, `/${pattern}/ should match ${JSON.stringify(input)}`);
  assert.deepEqual(
    m.slices,
    expected,
    `/${pattern}/ on ${JSON.stringify(input)} captured ${JSON.stringify(m.slices)}`,
  );
}

/** Asserts acceptance agrees with the platform engine as well as expectation. */
export function expectAccepts(pattern: string, input: string, want: boolean): void {
  const got = new Regex(pattern).test(input);
  assert.equal(got, want, `/${pattern}/.test(${JSON.stringify(input)})`);
  assert.equal(
    got,
    new RegExp(pattern).test(input),
    `/${pattern}/ disagrees with the platform engine on ${JSON.stringify(input)}`,
  );
}

export function spans(pattern: string, input: string): (readonly [number, number] | null)[] | null {
  const m = new Regex(pattern).exec(input);
  return m === null ? null : [...m.groups];
}
