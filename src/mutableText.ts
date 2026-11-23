import { oneByteText } from './oneByteText';

export class MutableText {
  private chunks: string[];
  length: number;
  // The chunk charAt() last landed in. Matchers read forward from one site,
  // so resuming here keeps a read O(1) instead of a walk over every splice.
  private cursorChunk = 0;
  private cursorOffset = 0;

  constructor(content: string) {
    this.chunks = content ? [content] : [];
    this.length = content.length;
  }

  charAt(index: number): string {
    if (index < 0 || index >= this.length) return '';
    let chunk = this.cursorChunk;
    let offset = this.cursorOffset;
    if (index < offset) {
      chunk = 0;
      offset = 0;
    }
    while (chunk < this.chunks.length) {
      const end = offset + this.chunks[chunk].length;
      if (index < end) {
        this.cursorChunk = chunk;
        this.cursorOffset = offset;
        return this.chunks[chunk][index - offset];
      }
      offset = end;
      chunk++;
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

  splice(start: number, end: number, text: string): void {
    const replacement = oneByteText(text);
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
    this.cursorChunk = 0;
    this.cursorOffset = 0;
  }

  // Joining is a full copy of the text. Keep the result as the only chunk so
  // a second call before the next splice reuses it instead of copying again.
  toString(): string {
    if (this.chunks.length > 1) {
      this.chunks = [this.chunks.join('')];
      this.cursorChunk = 0;
      this.cursorOffset = 0;
    }
    return this.chunks[0] ?? '';
  }
}
