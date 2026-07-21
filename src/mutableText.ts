export class MutableText {
  private chunks: string[];
  length: number;

  constructor(content: string) {
    this.chunks = content ? [content] : [];
    this.length = content.length;
  }

  charAt(index: number): string {
    if (index < 0 || index >= this.length) return '';
    let offset = 0;
    for (const chunk of this.chunks) {
      const end = offset + chunk.length;
      if (index < end) return chunk[index - offset];
      offset = end;
    }
    return '';
  }

  slice(start: number, end: number): string {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    if (from === to) return '';
    const parts: string[] = [];
    let offset = 0;
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd <= from) {
        offset = chunkEnd;
        continue;
      }
      if (offset >= to) break;
      parts.push(
        chunk.slice(
          Math.max(0, from - offset),
          Math.min(chunk.length, to - offset)
        )
      );
      offset = chunkEnd;
    }
    return parts.join('');
  }

  splice(start: number, end: number, replacement: string): void {
    const from = Math.max(0, Math.min(this.length, start));
    const to = Math.max(from, Math.min(this.length, end));
    const next: string[] = [];
    let offset = 0;
    let inserted = false;
    for (const chunk of this.chunks) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd <= from) {
        next.push(chunk);
      } else if (offset >= to) {
        if (!inserted && replacement) next.push(replacement);
        inserted = true;
        next.push(chunk);
      } else {
        const prefix = chunk.slice(0, Math.max(0, from - offset));
        const suffix = chunk.slice(Math.max(0, to - offset));
        if (prefix) next.push(prefix);
        if (!inserted && replacement) next.push(replacement);
        inserted = true;
        if (suffix) next.push(suffix);
      }
      offset = chunkEnd;
    }
    if (!inserted && replacement) next.push(replacement);
    this.chunks = next;
    this.length += replacement.length - (to - from);
  }

  toString(): string {
    return this.chunks.join('');
  }
}
