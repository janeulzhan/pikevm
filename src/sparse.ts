// Briggs and Torczon sparse set (1993, "An Efficient Representation for Sparse
// Sets"). Two integer arrays of size n give O(1) add, O(1) membership and O(1)
// clear, and iteration visits members in insertion order.
//
// Insertion order is load bearing here: the Pike VM relies on it to keep its
// thread list in priority order, which is what produces leftmost-first match
// semantics. A hash set would lose that for free, so the sparse set is not just
// a constant-factor win.
//
// The `sparse` array is intentionally left uninitialised on clear. A stale
// entry is harmless because membership also checks that `dense[sparse[v]] === v`.

export class SparseSet {
  readonly dense: Int32Array;
  private readonly sparse: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.dense = new Int32Array(capacity);
    this.sparse = new Int32Array(capacity);
  }

  get capacity(): number {
    return this.dense.length;
  }

  has(value: number): boolean {
    const i = this.sparse[value];
    return i < this.size && this.dense[i] === value;
  }

  /** Adds a value. Returns false when it was already present. */
  add(value: number): boolean {
    const i = this.sparse[value];
    if (i < this.size && this.dense[i] === value) return false;
    this.dense[this.size] = value;
    this.sparse[value] = this.size;
    this.size += 1;
    return true;
  }

  clear(): void {
    this.size = 0;
  }

  values(): number[] {
    return Array.from(this.dense.subarray(0, this.size));
  }
}
