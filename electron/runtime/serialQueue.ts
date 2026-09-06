/** A failed operation cannot poison later work. Pending includes queued work. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;
  get busy(): boolean {
    return this.count > 0;
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.count += 1;
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.count -= 1;
    });
  }
}
