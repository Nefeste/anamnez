// Очередь событий движка: двоичная куча по времени (`06-architecture.md` §4).
// При равном времени — по номеру постановки, чтобы порядок был детерминированным.

export interface Scheduled<E> {
  t: number;   // игровые секунды
  seq: number; // номер постановки
  event: E;
}

export class EventQueue<E> {
  private heap: Scheduled<E>[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(t: number, event: E): void {
    this.heap.push({ t, seq: this.nextSeq++, event });
    this.up(this.heap.length - 1);
  }

  peekTime(): number | undefined {
    return this.heap[0]?.t;
  }

  /** Достаёт ближайшее событие, если оно наступило к моменту `now`. */
  popDue(now: number): Scheduled<E> | undefined {
    const top = this.heap[0];
    if (!top || top.t > now) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.down(0);
    }
    return top;
  }

  /** Всё содержимое в порядке исполнения — для сохранения. */
  toArray(): Scheduled<E>[] {
    return [...this.heap].sort(compare);
  }

  static fromArray<E>(items: Scheduled<E>[]): EventQueue<E> {
    const q = new EventQueue<E>();
    for (const it of [...items].sort(compare)) {
      q.heap.push(it);
      q.nextSeq = Math.max(q.nextSeq, it.seq + 1);
    }
    return q;
  }

  private up(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private down(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && before(h[l], h[m])) m = l;
      if (r < h.length && before(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
}

function before<E>(a: Scheduled<E>, b: Scheduled<E>): boolean {
  return a.t < b.t || (a.t === b.t && a.seq < b.seq);
}

/** Сравнение для sort: число, а не булево значение. */
function compare<E>(a: Scheduled<E>, b: Scheduled<E>): number {
  return a.t - b.t || a.seq - b.seq;
}
