/**
 * 单消费者异步队列(spec §1c;原 claude-agent-provider 私有类原样提升)。
 * 契约(collectTurn watchdog 依赖,agent-provider.ts:378-381):
 *   - iterator.return() 同步 resolve 并关闭队列;
 *   - end() 后 buf 仍可排空(next 先查 buf 再查 closed);
 *   - push 于 closed 后静默丢弃;无背压(buf 无界);单消费者约定。
 * 不做任何"顺手改进"。
 */
export class AsyncQueue<T> {
  private buf: T[] = []
  private resolvers: ((v: IteratorResult<T>) => void)[] = []
  private closed = false
  push(v: T) {
    if (this.closed) return
    const r = this.resolvers.shift()
    if (r) r({ value: v, done: false })
    else this.buf.push(v)
  }
  end() {
    this.closed = true
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!
      r({ value: undefined as unknown as T, done: true })
    }
  }
  iterable(): AsyncIterable<T> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next() {
            if (self.buf.length > 0) return Promise.resolve({ value: self.buf.shift() as T, done: false })
            if (self.closed) return Promise.resolve({ value: undefined as unknown as T, done: true })
            return new Promise<IteratorResult<T>>(res => self.resolvers.push(res))
          },
          async return() { self.end(); return { value: undefined as unknown as T, done: true } },
        }
      },
    }
  }
}
