import { describe, expect, it } from 'vitest';

import {
  computeBunSectionPlacement,
  isClaudeModule,
  isPatchableJsModule,
  moduleSentinel,
  parseSentinelBundle,
} from './nativeInstallation';

describe('isClaudeModule', () => {
  it.each([
    'claude',
    '/usr/local/bin/claude',
    'claude.exe',
    'C:/tools/claude.exe',
    'src/entrypoints/cli.js',
    '/app/src/entrypoints/cli.js',
    '/$bunfs/root/cli',
    'B:/~BUN/root/cli',
    'B:\\~BUN\\root\\cli',
    'cli',
  ])('recognizes %s as the Claude entrypoint', moduleName => {
    expect(isClaudeModule(moduleName)).toBe(true);
  });

  it.each([
    '/$bunfs/root/image-processor.js',
    '/$bunfs/root/not-cli',
    'B:/~BUN/root/cli.js',
    '/other/cli',
  ])('rejects %s as a non-Claude module', moduleName => {
    expect(isClaudeModule(moduleName)).toBe(false);
  });
});

// Ported with upstream b36a8ca (#915) alongside the placement function itself.
//
// The effect is ELF-only, so it cannot be verified end to end on macOS: a darwin
// repack never reaches this path. That is exactly why the placement is a PURE
// FUNCTION of its inputs — the arithmetic that decides whether the output grows
// by a page or by 427 MB is checkable anywhere, against real segment numbers
// read out of a Linux binary, without needing one to hand.

// Real Claude Code 2.1.218 native (ELF) numbers, read via readelf:
//   RW PT_LOAD: vaddr 0x524f1a0, fileoff 0x504f1a0, filesz/memsz 0xb42ae60
//   -> segment mem-end (rwEnd) = 0x1067a000 (also the topmost LOAD end here)
//   LIEF.nextVirtualAddress() = 0x20000000 (rounds up to a 256MB boundary)
//   new .bun content = 0xb231a61, pageSize 0x1000
const REAL_218 = {
  rwVirtualAddress: 0x524f1a0n,
  rwVirtualSize: 0xb42ae60n,
  rwFileOffset: 0x504f1a0n,
  rwFileSize: 0xb42ae60n,
  topmostLoadEnd: 0x1067a000n,
  nextVirtualAddress: 0x20000000n,
  newContentSize: 0xb231a61n,
  pageSize: 0x1000n,
};

describe('computeBunSectionPlacement', () => {
  it('places the new .bun right after the writable segment when it is topmost (no zero-padding gap)', () => {
    const p = computeBunSectionPlacement(REAL_218);

    expect(p.compact).toBe(true);
    // immediately after the segment mem-end, page-aligned
    expect(p.newVaddr).toBe(0x1067a000n);
    // gap-free: the file only grows by the (aligned) new section size
    expect(p.extensionSize).toBe(p.alignedNewSize);
  });

  it('preserves the segment vaddr/fileoffset skew (keeps the ELF mapping valid)', () => {
    const p = computeBunSectionPlacement(REAL_218);
    const oldSkew = REAL_218.rwVirtualAddress - REAL_218.rwFileOffset;
    expect(p.newVaddr - p.newFileOffset).toBe(oldSkew);
  });

  it('never overlaps an existing segment (newVaddr >= topmost LOAD end)', () => {
    const p = computeBunSectionPlacement(REAL_218);
    expect(p.newVaddr >= REAL_218.topmostLoadEnd).toBe(true);
  });

  it('reclaims the ~262MB gap the nextVirtualAddress placement would have left', () => {
    const compact = computeBunSectionPlacement(REAL_218);
    // what the old code produced: newVaddr = align(nextVirtualAddress, page)
    const oldNewVaddr = 0x20000000n;
    const oldOffsetInSegment = oldNewVaddr - REAL_218.rwVirtualAddress;
    const oldNewFileOffset = REAL_218.rwFileOffset + oldOffsetInSegment;
    const oldRwFileEnd = REAL_218.rwFileOffset + REAL_218.rwFileSize;
    const oldExtension =
      oldNewFileOffset + compact.alignedNewSize - oldRwFileEnd;
    // the compact placement must save at least ~250MB of file
    expect(oldExtension - compact.extensionSize).toBeGreaterThan(250_000_000n);
  });

  it('falls back to nextVirtualAddress when the writable segment is NOT topmost', () => {
    // A higher LOAD segment exists above RW: compact placement would overlap it,
    // so the general-position-safe nextVirtualAddress placement must be used.
    const notTopmost = { ...REAL_218, topmostLoadEnd: 0x18000000n };
    const p = computeBunSectionPlacement(notTopmost);

    expect(p.compact).toBe(false);
    expect(p.newVaddr).toBe(0x20000000n); // align(nextVirtualAddress, page)
    expect(p.newVaddr >= notTopmost.topmostLoadEnd).toBe(true);
  });

  it('uses memsz (not filesz) for the segment end so a BSS tail is not overlapped', () => {
    // Hypothetical segment with a BSS gap: memsz > filesz. rwFileSize stays at
    // REAL_218's filesz; only memsz (and the matching topmost end) grow.
    const bssEnd = 0x524f1a0n + 0xb42ae60n + 0x10000n; // page-aligned
    const withBss = {
      ...REAL_218,
      rwVirtualSize: 0xb42ae60n + 0x10000n, // memsz extends past filesz
      topmostLoadEnd: bssEnd,
    };
    const p = computeBunSectionPlacement(withBss);
    // Must stay compact and land exactly at the memory end. If the segment end
    // were computed from filesz, rwMemEnd would fall below topmostLoadEnd, flip
    // compact to false, and silently revert to the nextVirtualAddress bloat.
    expect(p.compact).toBe(true);
    expect(p.newVaddr).toBe(bssEnd);
    // skew still preserved
    expect(p.newVaddr - p.newFileOffset).toBe(
      withBss.rwVirtualAddress - withBss.rwFileOffset
    );
  });

  it('page-aligns (rounds up) the compact placement when the segment mem-end is unaligned', () => {
    // mem-end no longer page-aligned: the placement must round UP to a page.
    const memEnd = 0x524f1a0n + 0xb42ae60n + 0x800n; // 0x1067a800, unaligned
    const unaligned = {
      ...REAL_218,
      rwVirtualSize: 0xb42ae60n + 0x800n,
      topmostLoadEnd: memEnd,
    };
    const p = computeBunSectionPlacement(unaligned);
    expect(p.compact).toBe(true);
    expect(p.newVaddr % REAL_218.pageSize).toBe(0n); // page-aligned
    expect(p.newVaddr).toBe(0x1067b000n); // rounded up from 0x1067a800
    expect(p.newVaddr > memEnd).toBe(true);
  });

  it('page-aligns the fallback placement when nextVirtualAddress is unaligned', () => {
    const notTopmost = {
      ...REAL_218,
      topmostLoadEnd: 0x18000000n, // RW not topmost -> fallback path
      nextVirtualAddress: 0x20000800n, // unaligned
    };
    const p = computeBunSectionPlacement(notTopmost);
    expect(p.compact).toBe(false);
    expect(p.newVaddr % REAL_218.pageSize).toBe(0n);
    expect(p.newVaddr).toBe(0x20001000n); // align(0x20000800, page)
  });
});

describe('isPatchableJsModule (CC 2.1.246 code-split bundles)', () => {
  it.each([
    ['/$bunfs/root/_444.js', 6801709],
    ['/$bunfs/root/chunk-8m05jgxf.js', 1040630],
    ['/$bunfs/root/cli', 20605],
  ])('patches %s', (name, len) => {
    expect(isPatchableJsModule(name, len)).toBe(true);
  });

  it.each([
    ['/$bunfs/root/computer-use-swift.node', 2507608],
    ['/$bunfs/root/payload.template.html.asset', 2488127],
    ['/$bunfs/root/image-processor.node', 1249368],
  ])('leaves the asset %s untouched', (name, len) => {
    expect(isPatchableJsModule(name, len)).toBe(false);
  });

  it('skips a module with no contents', () => {
    expect(isPatchableJsModule('/$bunfs/root/_1.js', 0)).toBe(false);
  });

  // CC 2.1.251 ships chart.umd.min.js, hljsBundle.generated.min.js and
  // mermaid.min.js as compressed binary payloads under a `.js` name. Letting
  // one into the virtual bundle corrupts it on the pipeline's UTF-8 round-trip
  // (mermaid measured 785,820 -> 1,415,201 bytes), and the patched binary then
  // ships a broken vendor asset.
  it('leaves a .js-named module whose bytes are not UTF-8 untouched', () => {
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0xef, 0x1e, 0x2d, 0xff]);
    expect(
      isPatchableJsModule('/$bunfs/root/mermaid.min.js', binary.length, binary)
    ).toBe(false);
  });

  it('still patches a .js module whose UTF-8 text has multi-byte characters', () => {
    const text = Buffer.from('let s="an em dash — and a café";\n', 'utf8');
    expect(isPatchableJsModule('/$bunfs/root/_444.js', text.length, text)).toBe(
      true
    );
  });
});

describe('parseSentinelBundle', () => {
  const bundle = (parts: Array<[number, string, string]>) =>
    Buffer.from(
      parts.map(([i, n, src]) => moduleSentinel(i, n) + src).join(''),
      'utf8'
    );

  it('returns null for a pre-2.1.246 single-module bundle', () => {
    expect(parseSentinelBundle(Buffer.from('let a=1;\n', 'utf8'))).toBeNull();
  });

  it('round-trips every module body exactly', () => {
    const buf = bundle([
      [0, '/$bunfs/root/_821.js', 'let a=1;\n'],
      [7, '/$bunfs/root/cli', 'import{x}from"/$bunfs/root/_821.js";\n'],
      [367, '/$bunfs/root/_444.js', 'let prompt=`You are Claude Code.`;\n'],
    ]);
    const got = parseSentinelBundle(buf);
    expect(got).not.toBeNull();
    expect([...got!.keys()].sort((a, b) => a - b)).toEqual([0, 7, 367]);
    expect(got!.get(0)!.toString()).toBe('let a=1;\n');
    expect(got!.get(367)!.toString()).toBe(
      'let prompt=`You are Claude Code.`;\n'
    );
  });

  it('keeps a body that itself contains backticks and ${} slots intact', () => {
    const src = 'let p=`a ${VAR} b`;\n';
    const got = parseSentinelBundle(bundle([[1, '/$bunfs/root/_1.js', src]]));
    expect(got!.get(1)!.toString()).toBe(src);
  });

  // Defence in depth for the same class: even if a non-UTF-8 module reached
  // the bundle, splitting it must not change a byte. A UTF-8 scan turns each
  // invalid byte into U+FFFD and re-encodes it as three, so the module fails
  // the `override.equals(original)` check and is written back mangled.
  it('round-trips a module body that is not valid UTF-8', () => {
    const binary = Buffer.from([0x9f, 0xef, 0x1e, 0x00, 0xfe, 0xc3, 0x28]);
    const buf = Buffer.concat([
      Buffer.from(moduleSentinel(1, '/$bunfs/root/_1.js'), 'utf8'),
      Buffer.from('let a=1;\n', 'utf8'),
      Buffer.from(moduleSentinel(2, '/$bunfs/root/mermaid.min.js'), 'utf8'),
      binary,
    ]);
    const got = parseSentinelBundle(buf);
    expect(got!.get(1)!.toString('utf8')).toBe('let a=1;\n');
    expect(got!.get(2)!.equals(binary)).toBe(true);
  });

  it('survives a patch that lengthened a module body', () => {
    const got = parseSentinelBundle(
      bundle([
        [1, '/$bunfs/root/_1.js', 'short\n'],
        [2, '/$bunfs/root/_2.js', 'a much longer body than before\n'],
      ])
    );
    expect(got!.get(2)!.toString()).toBe('a much longer body than before\n');
  });
});
