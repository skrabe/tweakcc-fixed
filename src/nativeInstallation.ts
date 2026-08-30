/**
 * Utilities for extracting and repacking native installation binaries.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import LIEF from 'node-lief';
import { isDebug, debug } from './utils';

// ============================================================================
// Nix binary wrapper detection
// ============================================================================

/**
 * Maximum file size for a Nix binary wrapper. These are tiny compiled C
 * programs (~5-20KB). Anything larger is definitely not a wrapper.
 */
const NIX_WRAPPER_MAX_SIZE = 200_000;

/**
 * Detects whether a binary is a Nix `makeBinaryWrapper` output and, if so,
 * extracts the path to the real wrapped executable.
 *
 * Nix's `makeBinaryWrapper` generates a small C program that:
 *   1. Manipulates the environment (setenv/unsetenv/putenv)
 *   2. Calls `execv("/nix/store/.../real-binary", argv)`
 *
 * The wrapper always embeds a DOCSTRING in `.rodata` (ELF) or `__cstring`
 * (Mach-O) containing the literal `makeCWrapper` invocation, whose first
 * argument is the real executable path. This is a contractual part of the
 * wrapper format (used by `makeBinaryWrapper.extractCmd`).
 *
 * Detection strategy:
 *   1. Size gate: wrappers are tiny (<200KB), real Bun binaries are multi-MB
 *   2. Symbol gate: wrappers import `execv`, real Bun apps do not
 *   3. Parse the DOCSTRING: `makeCWrapper '/nix/store/.../real-binary' ...`
 *   4. Fallback: find `/nix/store/` paths with `/bin/` in `.rodata`
 *
 * @returns The path to the real wrapped executable, or null if not a wrapper.
 */
export function resolveNixBinaryWrapper(binaryPath: string): string | null {
  try {
    // Gate 1: file size — wrappers are tiny
    const stat = fs.statSync(binaryPath);
    if (stat.size > NIX_WRAPPER_MAX_SIZE) {
      return null;
    }

    LIEF.logging.disable();
    const binary = LIEF.parse(binaryPath);

    // Gate 2: must import execv — the hallmark of a makeBinaryWrapper
    const symbols = binary.symbols();
    const hasExecv = symbols.some(sym => {
      const name = sym.name;
      return name === 'execv' || name === '_execv';
    });

    if (!hasExecv) {
      debug(
        'resolveNixBinaryWrapper: no execv import found, not a Nix wrapper'
      );
      return null;
    }

    debug(
      'resolveNixBinaryWrapper: execv import found, checking for Nix wrapper DOCSTRING'
    );

    // Extract string data from .rodata (ELF) or __TEXT,__cstring (Mach-O)
    let rawBytes: Buffer | null = null;

    if (binary.format === 'ELF') {
      const rodata = binary.sections().find(s => s.name === '.rodata');
      if (rodata) {
        rawBytes = rodata.content;
      }
    } else if (binary.format === 'MachO') {
      const machoBinary = binary as LIEF.MachO.Binary;
      const textSeg = machoBinary.getSegment('__TEXT');
      if (textSeg) {
        const cstring = textSeg.getSection('__cstring');
        if (cstring) {
          rawBytes = cstring.content;
        }
      }
    }

    if (!rawBytes || rawBytes.length === 0) {
      debug('resolveNixBinaryWrapper: could not read string section');
      return null;
    }

    const text = rawBytes.toString('utf-8');

    // Strategy 1: parse the DOCSTRING
    // makeBinaryWrapper always embeds: makeCWrapper '/nix/store/.../real' ...
    const docstringMatch = text.match(/makeCWrapper\s+'(\/nix\/store\/[^']+)'/);
    if (docstringMatch) {
      const resolvedPath = docstringMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }

    // Also handle unquoted (shouldn't happen but defensive)
    const unquotedMatch = text.match(/makeCWrapper\s+(\/nix\/store\/\S+)/);
    if (unquotedMatch) {
      const resolvedPath = unquotedMatch[1];
      debug(
        `resolveNixBinaryWrapper: found wrapped executable via unquoted DOCSTRING: ${resolvedPath}`
      );
      return resolvedPath;
    }

    // Strategy 2: find /nix/store/ paths in the string table
    // The execv target is the one that points to an executable (contains /bin/)
    // as opposed to env var values (--prefix PATH) which point to directories.
    const nixPaths = text.match(/\/nix\/store\/[^\0\n\r]+/g);
    if (nixPaths) {
      for (const p of nixPaths) {
        if (p.includes('/bin/')) {
          debug(
            `resolveNixBinaryWrapper: found wrapped executable via /bin/ heuristic: ${p}`
          );
          return p;
        }
      }
    }

    debug('resolveNixBinaryWrapper: has execv but no Nix store paths found');
    return null;
  } catch (error) {
    debug('resolveNixBinaryWrapper: error during detection:', error);
    return null;
  }
}

/**
 * Constants for Bun trailer and serialized layout sizes.
 *
 * Bun data layout (normalized across formats) is:
 * [data...][OFFSETS struct][BUN_TRAILER]
 *
 * Where OFFSETS struct (SIZEOF_OFFSETS bytes) is:
 * - byteCount:   u64  (total size of [data][OFFSETS][BUN_TRAILER])
 * - modulesPtr:  { u32 offset, u32 length } into [data...] for modules table
 * - entryPointId: u32
 * - compileExecArgvPtr: { u32 offset, u32 length }
 * - flags: u32
 */
const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const BUN_BYTECODE_PREFIX = '// @bun @bytecode';
// A `// @bun @bytecode @bun-cjs` header marks a readable CommonJS SOURCE module
// (patchable JS), NOT compiled bytecode — so it must NOT trigger the npm-source
// fallback. This marker distinguishes the two.
const BUN_CJS_MARKER = '@bun-cjs';

// Size constants for binary structures
const SIZEOF_OFFSETS = 32;
const SIZEOF_STRING_POINTER = 8;
// Module struct sizes vary by Bun version:
// - Old format (pre-ESM bytecode, before Bun ~1.3.7): 4 StringPointers + 4 u8s = 36 bytes
// - New format (ESM bytecode, Bun ~1.3.7+): 6 StringPointers + 4 u8s = 52 bytes
const SIZEOF_MODULE_OLD = 4 * SIZEOF_STRING_POINTER + 4;
const SIZEOF_MODULE_NEW = 6 * SIZEOF_STRING_POINTER + 4;

// Types
interface StringPointer {
  offset: number;
  length: number;
}

interface BunOffsets {
  byteCount: bigint | number;
  modulesPtr: StringPointer;
  entryPointId: number;
  compileExecArgvPtr: StringPointer;
  flags: number;
}

interface BunModule {
  name: StringPointer;
  contents: StringPointer;
  sourcemap: StringPointer;
  bytecode: StringPointer;
  moduleInfo: StringPointer;
  bytecodeOriginPath: StringPointer;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
}

interface BunData {
  bunOffsets: BunOffsets;
  bunData: Buffer;
  /** Header size used in section format: 4 for old format (Bun < 1.3.4), 8 for new format. Only for Mach-O and PE. */
  sectionHeaderSize?: number;
  /** Detected module struct size: SIZEOF_MODULE_OLD (36) or SIZEOF_MODULE_NEW (52). */
  moduleStructSize: number;
}

interface LocatedBundle extends BunData {
  offset: number;
  length: number;
  write(newBunBuffer: Buffer, outputPath: string): void;
}

/**
 * Read a StringPointer slice from given buffer.
 */
function getStringPointerContent(
  buffer: Buffer,
  stringPointer: StringPointer
): Buffer {
  return buffer.subarray(
    stringPointer.offset,
    stringPointer.offset + stringPointer.length
  );
}

function parseStringPointer(buffer: Buffer, offset: number): StringPointer {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4),
  };
}

/**
 * True if the module represents the native claude entrypoint.
 */
export function isClaudeModule(moduleName: string): boolean {
  const normalizedName = moduleName.replaceAll('\\', '/');
  return (
    normalizedName.endsWith('/claude') ||
    normalizedName === 'claude' ||
    normalizedName.endsWith('/claude.exe') ||
    normalizedName === 'claude.exe' ||
    normalizedName.endsWith('/src/entrypoints/cli.js') ||
    normalizedName === 'src/entrypoints/cli.js' ||
    normalizedName === '/$bunfs/root/cli' ||
    normalizedName === 'B:/~BUN/root/cli' ||
    normalizedName === 'cli'
  );
}

/**
 * CC 2.1.246 code-split the app: `/$bunfs/root/cli` became a ~20 KB ESM entry
 * loader and the real code moved into ~1,400 sibling modules, 128 of which
 * carry model-facing prompt text. Every downstream consumer (patches, prompt
 * overrides, the extractor) is written against ONE `cli.js` string, so instead
 * of threading a module array through all of them we hand them a single
 * VIRTUAL bundle: every JS module concatenated, each preceded by a sentinel
 * comment naming its module-table index. Repack splits on the same sentinel
 * and writes each segment back to its own module.
 *
 * The sentinel is a block comment, so the bundle stays valid-ish JS, and
 * `/*@@` appears in zero of the 1,411 real modules (checked on 2.1.246).
 */
const MODULE_SENTINEL_RE = /\n\/\*@@TWEAKCC_MODULE:(\d+):([^@]*)@@\*\/\n/g;

export const moduleSentinel = (index: number, name: string): string =>
  `\n/*@@TWEAKCC_MODULE:${index}:${name}@@*/\n`;

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

/**
 * True when every byte decodes as UTF-8. A `.js` name is not proof of JS
 * source: CC 2.1.251 ships chart.umd.min.js, hljsBundle.generated.min.js and
 * mermaid.min.js as compressed binary payloads. Those cannot survive the
 * pipeline's `toString('utf8')` -> patch -> `Buffer.from(…, 'utf8')` round-trip
 * (each invalid byte becomes U+FFFD and re-encodes as three), so they must
 * never enter the virtual bundle in the first place.
 */
function isUtf8Text(contents: Buffer): boolean {
  try {
    UTF8_STRICT.decode(contents);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a module whose contents tweakcc may patch. Assets (`.node`,
 * `.html.asset`, `.wasm`) are passed through untouched, as is any `.js`-named
 * module whose bytes are not UTF-8 text — pass `contents` wherever it is
 * available so that check can run.
 */
export function isPatchableJsModule(
  moduleName: string,
  contentsLength: number,
  contents?: Buffer
): boolean {
  if (contentsLength <= 0) return false;
  const n = moduleName.replaceAll('\\', '/');
  if (!n.endsWith('.js') && !isClaudeModule(n)) return false;
  return contents === undefined || isUtf8Text(contents);
}

/**
 * Split a virtual bundle back into `moduleIndex -> contents`.
 * Returns null when the buffer is not a sentinel bundle (pre-2.1.246 single
 * module), so the legacy path keeps working untouched.
 */
export function parseSentinelBundle(buf: Buffer): Map<number, Buffer> | null {
  // Scan and slice in LATIN-1, never UTF-8. Not every `.js` module is UTF-8
  // text: CC 2.1.251 ships chart.umd.min.js, hljsBundle.generated.min.js and
  // mermaid.min.js as compressed binary payloads. A `toString('utf8')` scan
  // turns each invalid byte into U+FFFD, and re-encoding that as UTF-8 emits
  // three bytes where one stood — mermaid went 785,820 -> 1,415,201 bytes. The
  // corrupted buffer then fails the `override.equals(original)` check in
  // rebuildBunDataAppendOnly, so it is appended as a "changed" module with its
  // bytecode dropped, and the patched binary ships a broken vendor asset. Only
  // the parse-oracle control caught it. Latin-1 is a total byte<->char
  // bijection, so boundaries found in it index the buffer exactly and every
  // slice round-trips whatever it held.
  const text = buf.toString('latin1');
  if (!text.includes('/*@@TWEAKCC_MODULE:')) return null;

  const byIndex = new Map<number, Buffer>();
  const marks: Array<{ index: number; start: number; end: number }> = [];
  MODULE_SENTINEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MODULE_SENTINEL_RE.exec(text)) !== null) {
    marks.push({
      index: Number(m[1]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (marks.length === 0) return null;

  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : buf.length;
    byIndex.set(marks[i].index, Buffer.from(buf.subarray(from, to)));
  }
  return byIndex;
}

/**
 * Detects the module struct size from the modules list byte length.
 * Returns SIZEOF_MODULE_NEW (52) or SIZEOF_MODULE_OLD (36).
 */
function detectModuleStructSize(modulesListLength: number): number {
  const fitsNew = modulesListLength % SIZEOF_MODULE_NEW === 0;
  const fitsOld = modulesListLength % SIZEOF_MODULE_OLD === 0;

  if (fitsNew && !fitsOld) return SIZEOF_MODULE_NEW;
  if (fitsOld && !fitsNew) return SIZEOF_MODULE_OLD;
  if (fitsNew && fitsOld) {
    // Ambiguous — prefer new format (more likely with recent Bun versions)
    debug(
      `detectModuleStructSize: Ambiguous module list length ${modulesListLength}, assuming new format`
    );
    return SIZEOF_MODULE_NEW;
  }

  // Neither fits cleanly — try new format as default
  debug(
    `detectModuleStructSize: Module list length ${modulesListLength} doesn't cleanly divide by either struct size, assuming new format`
  );
  return SIZEOF_MODULE_NEW;
}

/**
 * Iterates over modules in the Bun data and calls visitor for each.
 * Handles all module parsing and iteration logic in one place.
 */
function mapModules<T>(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  moduleStructSize: number,
  visitor: (
    module: BunModule,
    moduleName: string,
    index: number
  ) => T | undefined
): T | undefined {
  const modulesListBytes = getStringPointerContent(
    bunData,
    bunOffsets.modulesPtr
  );
  const modulesListCount = Math.floor(
    modulesListBytes.length / moduleStructSize
  );

  for (let i = 0; i < modulesListCount; i++) {
    const offset = i * moduleStructSize;
    const module = parseCompiledModuleGraphFile(
      modulesListBytes,
      offset,
      moduleStructSize
    );
    const moduleName = getStringPointerContent(bunData, module.name).toString(
      'utf-8'
    );

    const result = visitor(module, moduleName, i);
    if (result !== undefined) {
      return result;
    }
  }

  return undefined;
}

function parseOffsets(buffer: Buffer): BunOffsets {
  let pos = 0;
  const byteCount = buffer.readBigUInt64LE(pos);
  pos += 8;
  const modulesPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const entryPointId = buffer.readUInt32LE(pos);
  pos += 4;
  const compileExecArgvPtr = parseStringPointer(buffer, pos);
  pos += 8;
  const flags = buffer.readUInt32LE(pos);

  return { byteCount, modulesPtr, entryPointId, compileExecArgvPtr, flags };
}

function parseCompiledModuleGraphFile(
  buffer: Buffer,
  offset: number,
  moduleStructSize: number
): BunModule {
  let pos = offset;
  const name = parseStringPointer(buffer, pos);
  pos += 8;
  const contents = parseStringPointer(buffer, pos);
  pos += 8;
  const sourcemap = parseStringPointer(buffer, pos);
  pos += 8;
  const bytecode = parseStringPointer(buffer, pos);
  pos += 8;

  let moduleInfo: StringPointer;
  let bytecodeOriginPath: StringPointer;
  if (moduleStructSize === SIZEOF_MODULE_NEW) {
    moduleInfo = parseStringPointer(buffer, pos);
    pos += 8;
    bytecodeOriginPath = parseStringPointer(buffer, pos);
    pos += 8;
  } else {
    moduleInfo = { offset: 0, length: 0 };
    bytecodeOriginPath = { offset: 0, length: 0 };
  }

  const encoding = buffer.readUInt8(pos);
  pos += 1;
  const loader = buffer.readUInt8(pos);
  pos += 1;
  const moduleFormat = buffer.readUInt8(pos);
  pos += 1;
  const side = buffer.readUInt8(pos);

  return {
    name,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    encoding,
    loader,
    moduleFormat,
    side,
  };
}

/**
 * Parses Bun data blob that contains: [data][offsets][trailer]
 * This is the common structure across all formats after extraction.
 */
function parseBunDataBlob(bunDataContent: Buffer): {
  bunOffsets: BunOffsets;
  bunData: Buffer;
  moduleStructSize: number;
} {
  if (bunDataContent.length < SIZEOF_OFFSETS + BUN_TRAILER.length) {
    throw new Error('BUN data is too small to contain trailer and offsets');
  }

  // Verify trailer
  const trailerStart = bunDataContent.length - BUN_TRAILER.length;
  const trailerBytes = bunDataContent.subarray(trailerStart);

  debug(`parseBunDataBlob: Expected trailer: ${BUN_TRAILER.toString('hex')}`);
  debug(`parseBunDataBlob: Got trailer: ${trailerBytes.toString('hex')}`);

  if (!trailerBytes.equals(BUN_TRAILER)) {
    // Expected/Got hex already logged just above on every call.
    throw new Error('BUN trailer bytes do not match trailer');
  }

  // Parse Offsets structure
  const offsetsStart =
    bunDataContent.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  const offsetsBytes = bunDataContent.subarray(
    offsetsStart,
    offsetsStart + SIZEOF_OFFSETS
  );
  const bunOffsets = parseOffsets(offsetsBytes);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

  return {
    bunOffsets,
    bunData: bunDataContent,
    moduleStructSize,
  };
}

/**
 * Section format helper (for Mach-O and PE):
 * Old format (Bun < 1.3.4): [u32 size][size bytes of Bun data blob...]
 * New format (Bun >= 1.3.4): [u64 size][size bytes of Bun data blob...]
 *
 * Size is the length of the Bun blob (which itself is [data][OFFSETS][TRAILER]).
 * We detect which format by checking if (headerSize + size) matches the section length.
 */
function extractBunDataFromSection(sectionData: Buffer): BunData {
  if (sectionData.length < 4) {
    throw new Error('Section data too small');
  }

  debug(`extractBunDataFromSection: sectionData.length=${sectionData.length}`);

  // Try u32 header (old format, Bun < 1.3.4)
  const bunDataSizeU32 = sectionData.readUInt32LE(0);
  const expectedLengthU32 = 4 + bunDataSizeU32;

  // Try u64 header (new format, Bun >= 1.3.4) - only if we have enough bytes
  const bunDataSizeU64 =
    sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const expectedLengthU64 = 8 + bunDataSizeU64;

  debug(
    `extractBunDataFromSection: u32 header would give size=${bunDataSizeU32}, expected total=${expectedLengthU32}`
  );
  debug(
    `extractBunDataFromSection: u64 header would give size=${bunDataSizeU64}, expected total=${expectedLengthU64}`
  );

  let headerSize: number;
  let bunDataSize: number;

  // Check which format matches the section length (allowing for padding up to 4KB)
  if (
    sectionData.length >= 8 &&
    expectedLengthU64 <= sectionData.length &&
    expectedLengthU64 >= sectionData.length - 4096
  ) {
    // u64 format matches
    headerSize = 8;
    bunDataSize = bunDataSizeU64;
    debug(
      `extractBunDataFromSection: detected u64 header format (Bun >= 1.3.4)`
    );
  } else if (
    expectedLengthU32 <= sectionData.length &&
    expectedLengthU32 >= sectionData.length - 4096
  ) {
    // u32 format matches
    headerSize = 4;
    bunDataSize = bunDataSizeU32;
    debug(
      `extractBunDataFromSection: detected u32 header format (Bun < 1.3.4)`
    );
  } else {
    throw new Error(
      `Cannot determine section header format: sectionData.length=${sectionData.length}, ` +
        `u64 would expect ${expectedLengthU64}, u32 would expect ${expectedLengthU32}`
    );
  }

  debug(`extractBunDataFromSection: bunDataSize from header=${bunDataSize}`);

  const bunDataContent = sectionData.subarray(
    headerSize,
    headerSize + bunDataSize
  );

  debug(
    `extractBunDataFromSection: bunDataContent.length=${bunDataContent.length}`
  );

  const { bunOffsets, bunData, moduleStructSize } =
    parseBunDataBlob(bunDataContent);

  return {
    bunOffsets,
    bunData,
    sectionHeaderSize: headerSize,
    moduleStructSize,
  };
}

/**
 * New ELF format (Bun >= 1.3.x, post-PR#26923):
 * Bun data is stored in a .bun ELF section, using the same
 * [u64 payload_len][payload bytes] format as macOS and PE.
 *
 * At build time, Bun's writeBunSection() appends the module graph data to
 * the end of the ELF, creates a PT_LOAD segment for it, and updates the
 * .bun section header to point there. The original BUN_COMPILED location
 * (in the RW data segment) stores a vaddr pointing to the appended data.
 *
 * Returns null if the .bun section doesn't exist or doesn't have valid data.
 */
function extractBunDataFromELFSection(
  elfBinary: LIEF.ELF.Binary
): BunData | null {
  try {
    const bunSection = elfBinary.getSection('.bun');
    if (!bunSection) {
      debug('extractBunDataFromELFSection: .bun section not found');
      return null;
    }

    const sectionContent = bunSection.content;
    if (sectionContent.length < 8) {
      debug('extractBunDataFromELFSection: .bun section too small');
      return null;
    }

    debug(
      `extractBunDataFromELFSection: .bun section found, size=${sectionContent.length}`
    );

    // The .bun section uses the same [u64 size][payload] format as macOS/PE
    const result = extractBunDataFromSection(sectionContent);
    debug('extractBunDataFromELFSection: successfully extracted data');
    return result;
  } catch (error) {
    debug('extractBunDataFromELFSection: failed to extract:', error);
    return null;
  }
}

/**
 * Legacy ELF layout (Bun < 1.3.x, pre-PR#26923):
 * [original ELF ...][Bun data...][Bun offsets][Bun trailer][u64 totalByteCount]
 *
 * Matches bun_unpack.py logic: parse Offsets structure and use its byteCount
 * field instead of the trailing totalByteCount (which is unreliable for musl).
 */
function extractBunDataFromELFOverlay(elfBinary: LIEF.ELF.Binary): BunData {
  if (!elfBinary.hasOverlay) {
    throw new Error('ELF binary has no overlay data');
  }

  const overlayData = elfBinary.overlay;
  debug(
    `extractBunDataFromELFOverlay: Overlay size=${overlayData.length} bytes`
  );

  if (overlayData.length < BUN_TRAILER.length + 8 + SIZEOF_OFFSETS) {
    throw new Error('ELF overlay data is too small');
  }

  // Read totalByteCount from last 8 bytes
  const totalByteCount = overlayData.readBigUInt64LE(overlayData.length - 8);
  debug(
    `extractBunDataFromELFOverlay: Total byte count from tail=${totalByteCount}`
  );

  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count is out of range: ${totalByteCount}`);
  }

  // Verify trailer at [len - 8 - trailer_len : len - 8]
  const trailerStart = overlayData.length - 8 - BUN_TRAILER.length;
  const trailerBytes = overlayData.subarray(
    trailerStart,
    overlayData.length - 8
  );

  debug(
    `extractBunDataFromELFOverlay: Expected trailer: ${BUN_TRAILER.toString('hex')}`
  );
  debug(
    `extractBunDataFromELFOverlay: Got trailer: ${trailerBytes.toString('hex')}`
  );

  if (!trailerBytes.equals(BUN_TRAILER)) {
    throw new Error('BUN trailer bytes do not match trailer');
  }

  // Parse Offsets at [len - 8 - trailer_len - sizeof_offsets : len - 8 - trailer_len]
  const offsetsStart =
    overlayData.length - 8 - BUN_TRAILER.length - SIZEOF_OFFSETS;
  const offsetsBytes = overlayData.subarray(
    offsetsStart,
    overlayData.length - 8 - BUN_TRAILER.length
  );
  const bunOffsets = parseOffsets(offsetsBytes);

  debug(
    `extractBunDataFromELFOverlay: Offsets.byteCount=${bunOffsets.byteCount}`
  );

  // Validate byteCount from Offsets structure
  const byteCount =
    typeof bunOffsets.byteCount === 'bigint'
      ? bunOffsets.byteCount
      : BigInt(bunOffsets.byteCount);

  if (byteCount >= totalByteCount) {
    throw new Error('ELF total byte count is out of range');
  }

  // Extract data region using byteCount from Offsets (not totalByteCount)
  const tailDataLen = 8 + BUN_TRAILER.length + SIZEOF_OFFSETS;
  const dataStart = overlayData.length - tailDataLen - Number(byteCount);
  const dataRegion = overlayData.subarray(
    dataStart,
    overlayData.length - tailDataLen
  );

  debug(
    `extractBunDataFromELFOverlay: Extracted ${dataRegion.length} bytes of data`
  );

  // Reconstruct full blob [data][offsets][trailer] to match other formats
  const bunDataBlob = Buffer.concat([dataRegion, offsetsBytes, trailerBytes]);
  const moduleStructSize = detectModuleStructSize(bunOffsets.modulesPtr.length);

  return {
    bunOffsets,
    bunData: bunDataBlob,
    moduleStructSize,
  };
}

/**
 * Mach-O layout:
 * __BUN/__bun section content is:
 * [u32 size][size bytes of Bun blob...]
 */
function extractBunDataFromMachO(machoBinary: LIEF.MachO.Binary): BunData {
  const bunSegment = machoBinary.getSegment('__BUN');
  if (!bunSegment) {
    throw new Error('__BUN segment not found');
  }

  const bunSection = bunSegment.getSection('__bun');
  if (!bunSection) {
    throw new Error('__bun section not found');
  }

  return extractBunDataFromSection(bunSection.content);
}

/**
 * PE layout:
 * .bun section content is:
 * [u32 size][size bytes of Bun blob...]
 */
function extractBunDataFromPE(peBinary: LIEF.PE.Binary): BunData {
  const bunSection = peBinary.sections().find(s => s.name === '.bun');

  if (!bunSection) {
    throw new Error('.bun section not found');
  }

  return extractBunDataFromSection(bunSection.content);
}

function getExpectedFormatForPlatform(): 'MachO' | 'ELF' | 'PE' | null {
  switch (process.platform) {
    case 'darwin':
      return 'MachO';
    case 'linux':
      return 'ELF';
    case 'win32':
      return 'PE';
    default:
      return null;
  }
}

function assertPlatformFormat(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary
): void {
  // TEST-ONLY ESCAPE HATCH. The guard is right for users: patching a
  // wrong-platform binary is never what they meant. But it also made the ELF
  // repack path impossible to exercise from a Mac, so the Linux legs of a
  // release could only ever be tested by shipping to a Linux box first. That
  // is exactly backwards for the riskiest code in the repo. With this set, a
  // darwin checkout can extract and repack the linux-arm64 and linux-x64
  // builds (npm: @anthropic-ai/claude-code-linux-{arm64,x64}) and prove the
  // ELF path before anything is published. Never set it in a real apply.
  if (process.env.TWEAKCC_ALLOW_CROSS_PLATFORM === '1') {
    debug(
      `assertPlatformFormat: cross-platform check bypassed for ${binary.format}`
    );
    return;
  }
  const expectedFormat = getExpectedFormatForPlatform();
  if (expectedFormat && binary.format !== expectedFormat) {
    throw new Error(
      `Native binary format ${binary.format} does not match ${process.platform} (${expectedFormat})`
    );
  }
}

function locateBundle(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary,
  binPath: string
): LocatedBundle {
  debug(`locateBundle: Binary format detected as ${binary.format}`);
  assertPlatformFormat(binary);

  switch (binary.format) {
    case 'MachO': {
      const machoBinary = binary as LIEF.MachO.Binary;
      const data = extractBunDataFromMachO(machoBinary);
      if (!data.sectionHeaderSize) {
        throw new Error('sectionHeaderSize is required for Mach-O binaries');
      }
      const bunSection = machoBinary.getSegment('__BUN')!.getSection('__bun')!;
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) =>
          repackMachO(
            machoBinary,
            binPath,
            newBunBuffer,
            outputPath,
            data.sectionHeaderSize!
          ),
      };
    }
    case 'PE': {
      const peBinary = binary as LIEF.PE.Binary;
      const data = extractBunDataFromPE(peBinary);
      if (!data.sectionHeaderSize) {
        throw new Error('sectionHeaderSize is required for PE binaries');
      }
      const bunSection = peBinary.sections().find(s => s.name === '.bun')!;
      return {
        ...data,
        offset: Number(bunSection.fileOffset),
        length: bunSection.content.length,
        write: (newBunBuffer, outputPath) =>
          repackPE(
            peBinary,
            binPath,
            newBunBuffer,
            outputPath,
            data.sectionHeaderSize!
          ),
      };
    }
    case 'ELF': {
      const elfBinary = binary as LIEF.ELF.Binary;
      const sectionResult = extractBunDataFromELFSection(elfBinary);
      if (sectionResult) {
        debug('locateBundle: Using new ELF .bun section format');
        if (!sectionResult.sectionHeaderSize) {
          throw new Error('sectionHeaderSize is required for ELF .bun section');
        }
        return {
          ...sectionResult,
          offset: Number(elfBinary.getSection('.bun')!.fileOffset),
          length: elfBinary.getSection('.bun')!.content.length,
          write: (newBunBuffer, outputPath) =>
            repackELFSection(
              elfBinary,
              binPath,
              newBunBuffer,
              outputPath,
              sectionResult.sectionHeaderSize!
            ),
        };
      }
      debug('locateBundle: Falling back to legacy ELF overlay format');
      const data = extractBunDataFromELFOverlay(elfBinary);
      const stat = fs.statSync(binPath);
      return {
        ...data,
        offset: stat.size - elfBinary.overlay.length,
        length: elfBinary.overlay.length,
        write: (newBunBuffer, outputPath) =>
          repackELFOverlay(elfBinary, binPath, newBunBuffer, outputPath),
      };
    }
    default: {
      const _exhaustive: never = binary;
      throw new Error(
        `Unsupported binary format: ${(_exhaustive as LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary).format}`
      );
    }
  }
}

/**
 * Extracts claude.js from a native installation binary.
 * Returns the contents as a Buffer, or null if not found.
 *
 * Note: If the binary might be a Nix `makeBinaryWrapper` wrapper, callers
 * should resolve it first using `resolveNixBinaryWrapper()` and pass the
 * real binary path here. This is handled at detection time in
 * `installationDetection.ts`.
 */
function fetchNpmSource(version: string): Buffer | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-npm-'));
  try {
    debug(`fetchNpmSource: Downloading @anthropic-ai/claude-code@${version}`);
    execFileSync(
      'npm',
      [
        'pack',
        `@anthropic-ai/claude-code@${version}`,
        '--pack-destination',
        tmpDir,
      ],
      { stdio: 'pipe', timeout: 30_000, cwd: tmpDir }
    );

    const files = fs.readdirSync(tmpDir);
    const tgz = files.find(f => f.endsWith('.tgz'));
    if (!tgz) {
      debug('fetchNpmSource: No .tgz file found after npm pack');
      return null;
    }

    execFileSync('tar', ['xzf', path.join(tmpDir, tgz), 'package/cli.js'], {
      stdio: 'pipe',
      timeout: 30_000,
      cwd: tmpDir,
    });

    const cliJsPath = path.join(tmpDir, 'package', 'cli.js');
    if (!fs.existsSync(cliJsPath)) {
      debug('fetchNpmSource: cli.js not found in extracted package');
      return null;
    }

    const content = fs.readFileSync(cliJsPath);
    debug(`fetchNpmSource: Got cli.js, ${content.length} bytes`);
    return content;
  } catch (error) {
    debug('fetchNpmSource: Failed to fetch npm source:', error);
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function extractClaudeJsFromNativeInstallation(
  nativeInstallationPath: string,
  version?: string
): { data: Buffer | null; clearBytecode: boolean; error?: string } {
  try {
    LIEF.logging.disable();
    const binary = LIEF.parse(nativeInstallationPath);
    const { bunOffsets, bunData, moduleStructSize } = locateBundle(
      binary,
      nativeInstallationPath
    );

    debug(
      `extractClaudeJsFromNativeInstallation: Got bunData, size=${bunData.length} bytes, moduleStructSize=${moduleStructSize}`
    );

    // Decide which bundle shape this binary has. Up to CC 2.1.241 the claude
    // module WAS the app (~28 MB) and everything else was an asset. From
    // 2.1.246 the app is code-split, the claude module is a ~20 KB ESM entry
    // loader, and the real code — including 128 modules of prompt text — lives
    // in siblings. Comparing the two totals detects that without pinning a
    // version or a size threshold.
    let claudeLen = 0;
    let otherJsLen = 0;
    mapModules(bunData, bunOffsets, moduleStructSize, (module, moduleName) => {
      const len = module.contents.length;
      if (isClaudeModule(moduleName)) claudeLen = len;
      else if (isPatchableJsModule(moduleName, len)) otherJsLen += len;
      return undefined;
    });
    const codeSplit = otherJsLen > claudeLen;
    debug(
      `extractClaudeJsFromNativeInstallation: claudeLen=${claudeLen} otherJsLen=${otherJsLen} codeSplit=${codeSplit}`
    );

    if (codeSplit) {
      const parts: Buffer[] = [];
      let moduleCount = 0;
      mapModules(
        bunData,
        bunOffsets,
        moduleStructSize,
        (module, moduleName, index) => {
          if (module.contents.length <= 0) return undefined;
          const contents = getStringPointerContent(bunData, module.contents);
          if (
            !isPatchableJsModule(moduleName, module.contents.length, contents)
          ) {
            return undefined;
          }
          parts.push(Buffer.from(moduleSentinel(index, moduleName), 'utf8'));
          parts.push(contents);
          moduleCount++;
          return undefined;
        }
      );

      if (moduleCount === 0) {
        return {
          data: null,
          clearBytecode: false,
          error: 'code-split binary but no patchable JS modules were found',
        };
      }

      // The wording here deliberately avoids the strings used to detect a
      // PATCHED binary (`__tweakcc`, `tweakcc v`, the sentinel name). A
      // preamble containing them makes every pristine extraction look patched,
      // which is the one check standing between this pipeline and building a
      // catalogue out of already-lobotomized JS.
      // Lead with a real JS STATEMENT, not just comments. Callers that
      // MIME-sniff the bundle (the apply-safety harness writes it to a temp
      // `cli.js` and lets `resolvePathToInstallationType` detect it) classify a
      // file that opens with a comment block as plain text, and the harness
      // then cannot run at all — it reported FAIL for every set on every
      // platform while saying `apply ran: false`. CC's own single-module
      // cli.js happened to satisfy the sniffer because real code followed its
      // first comment line immediately; a 2.1.246 module opens with a long
      // licence comment and does not. Everything before the first sentinel is
      // discarded on split, so this preamble is inert for repack.
      const preamble = Buffer.from(
        `#!/usr/bin/env node\n// @bun @bytecode\n` +
          `// Virtual bundle: ${moduleCount} modules, split on the module ` +
          `sentinels below.\n` +
          `var __ccVirtualBundleModules = ${moduleCount};\n`,
        'utf8'
      );
      const bundle = Buffer.concat([preamble, ...parts]);
      debug(
        `extractClaudeJsFromNativeInstallation: built virtual bundle from ${moduleCount} modules, ${bundle.length} bytes`
      );
      // Bytecode is handled PER MODULE at repack time (only modules whose
      // source actually changed get their bytecode pointer zeroed), so the
      // global flag stays false here.
      return { data: bundle, clearBytecode: false };
    }

    const result = mapModules(
      bunData,
      bunOffsets,
      moduleStructSize,
      (module, moduleName, index) => {
        debug(
          `extractClaudeJsFromNativeInstallation: Module ${index}: ${moduleName}`
        );

        if (!isClaudeModule(moduleName)) return undefined;

        const moduleContents = getStringPointerContent(
          bunData,
          module.contents
        );

        debug(
          `extractClaudeJsFromNativeInstallation: Found claude module, contents length=${moduleContents.length}`
        );

        return moduleContents.length > 0 ? moduleContents : undefined;
      }
    );

    if (result) {
      const head = result.subarray(0, 64).toString('utf8');
      // Only ACTUAL bytecode (no @bun-cjs source marker) should fall back to
      // fetching npm source. Modern CC ships the claude module as readable
      // `// @bun @bytecode @bun-cjs` SOURCE — patchable directly — so the old
      // `startsWith` check false-matched it and ran a doomed `npm pack` on every
      // native apply (the npm package no longer ships package/cli.js). Skipping
      // it returns the same data with clearBytecode=false, and the patched source
      // executes (the bytecode field is vestigial for @bun-cjs modules). (F-67)
      if (
        head.startsWith(BUN_BYTECODE_PREFIX) &&
        !head.includes(BUN_CJS_MARKER)
      ) {
        debug(
          'extractClaudeJsFromNativeInstallation: Extracted content is Bun bytecode — falling back to npm source'
        );

        if (version) {
          const npmSource = fetchNpmSource(version);
          if (npmSource) {
            debug(
              `extractClaudeJsFromNativeInstallation: Using npm source (${npmSource.length} bytes) instead of bytecode`
            );
            return { data: npmSource, clearBytecode: true };
          }
          debug(
            'extractClaudeJsFromNativeInstallation: npm source fetch failed, returning bytecode content as-is'
          );
        } else {
          debug(
            'extractClaudeJsFromNativeInstallation: No version provided, cannot fetch npm source'
          );
        }
      }

      return { data: result, clearBytecode: false };
    }

    debug(
      'extractClaudeJsFromNativeInstallation: claude module not found in any module'
    );

    return {
      data: null,
      clearBytecode: false,
      error: 'claude module not found in any of the binary modules',
    };
  } catch (error) {
    debug(
      'extractClaudeJsFromNativeInstallation: Error during extraction:',
      error
    );

    return {
      data: null,
      clearBytecode: false,
      error: `extraction threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Rebuild bunData for a CODE-SPLIT binary (CC 2.1.246+) by APPENDING rather
 * than repacking.
 *
 * The full repack in `rebuildBunData` re-lays-out every string from scratch.
 * That was safe while the bundle was one CJS module whose bytecode Bun never
 * executed. It is not safe now: 2.1.246 ships 1,404 modules of REAL executable
 * bytecode, and the shipped layout guarantees invariants we can only partially
 * enumerate — `bytecode` and `moduleInfo` are 8-byte aligned in every module,
 * and re-packing them still produced a binary that segfaulted 8 ms into
 * startup even after both were aligned.
 *
 * So do not re-lay-out anything. Keep the entire referenced data region
 * BYTE-IDENTICAL, append the new contents of only the modules that changed,
 * and repoint just those modules. Every offset the original binary relied on
 * still resolves to the same bytes, so no undiscovered invariant can break.
 * The cost is that superseded contents and bytecode stay in the file as
 * unreferenced bytes — the binary grows by roughly the size of what changed.
 */
function rebuildBunDataAppendOnly(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  moduleStructSize: number,
  moduleOverrides: Map<number, Buffer>
): Buffer {
  const ALIGN = 8;
  const modOff = bunOffsets.modulesPtr.offset;

  // Everything a StringPointer can address lives BELOW the module table.
  const dataRegion = bunData.subarray(0, modOff);

  // Everything from the module table to the end is kept as ONE opaque block:
  // the table, then the post-table records, then compileExecArgv, the offsets
  // struct and the trailer. `flags = 255` on CC 2.1.246 sets
  // SOURCE_TEXT_CONTIGUOUS | HAS_SOURCE_HASHES | HAS_BUILTIN_BYTECODE |
  // HAS_BYTECODE_STRING_TABLE, and the source-hash array (1,582 * 4 bytes)
  // sits immediately after the table with no pointer to it. Rebuilding the
  // tail field by field silently drops those records, which is why an
  // otherwise byte-identical repack still segfaulted on startup. Moving the
  // block wholesale preserves every internal adjacency; only the three
  // absolute offsets in the offsets struct need fixing up.
  const tail = Buffer.from(bunData.subarray(modOff));

  const appended: Buffer[] = [];
  let cursor = dataRegion.length;
  let changedCount = 0;

  mapModules(bunData, bunOffsets, moduleStructSize, (module, _name, index) => {
    const override = moduleOverrides.get(index);
    if (!override) return undefined;
    const original = getStringPointerContent(bunData, module.contents);
    if (override.equals(original)) return undefined;

    const pad = cursor % ALIGN === 0 ? 0 : ALIGN - (cursor % ALIGN);
    if (pad > 0) {
      appended.push(Buffer.alloc(pad));
      cursor += pad;
    }
    const e = index * moduleStructSize;
    tail.writeUInt32LE(cursor, e + 8); // contents.offset
    tail.writeUInt32LE(override.length, e + 12); // contents.length
    // Bun runs the bytecode when a module has any, and that bytecode carries
    // its own copy of every string literal — so a source edit is inert until
    // the bytecode is dropped. Zeroing the LENGTH (keeping the offset) makes
    // JSC fall back to parsing the patched source.
    tail.writeUInt32LE(0, e + 28); // bytecode.length
    appended.push(override, Buffer.alloc(1)); // + null terminator
    cursor += override.length + 1;
    changedCount++;
    return undefined;
  });

  const tailPad = cursor % ALIGN === 0 ? 0 : ALIGN - (cursor % ALIGN);
  if (tailPad > 0) appended.push(Buffer.alloc(tailPad));
  const newModOff = cursor + tailPad;
  const delta = newModOff - modOff;

  debug(
    `rebuildBunDataAppendOnly: ${changedCount} module(s) changed, appended ${
      newModOff - dataRegion.length
    } bytes, tail shifted by ${delta}`
  );

  const out = Buffer.concat([dataRegion, ...appended, tail]);

  // Fix up the offsets struct (the 32 bytes before the 16-byte trailer).
  const st = out.length - SIZEOF_OFFSETS - BUN_TRAILER.length;
  out.writeBigUInt64LE(BigInt(Number(bunOffsets.byteCount) + delta), st);
  out.writeUInt32LE(newModOff, st + 8);
  out.writeUInt32LE(bunOffsets.compileExecArgvPtr.offset + delta, st + 20);

  return out;
}

function rebuildBunData(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  modifiedClaudeJs: Buffer | null,
  moduleStructSize: number,
  clearBytecode: boolean
): Buffer {
  // Phase 1: Collect all string data
  const stringsData: Buffer[] = [];
  const modulesMetadata: Array<{
    name: Buffer;
    contents: Buffer;
    sourcemap: Buffer;
    bytecode: Buffer;
    moduleInfo: Buffer;
    bytecodeOriginPath: Buffer;
    encoding: number;
    loader: number;
    moduleFormat: number;
    side: number;
  }> = [];

  // Use mapModules to iterate and collect module data
  mapModules(bunData, bunOffsets, moduleStructSize, (module, moduleName) => {
    const nameBytes = getStringPointerContent(bunData, module.name);

    // Check if this is claude.js and we have modified contents
    let contentsBytes: Buffer;
    let bytecodeBytes: Buffer;
    if (modifiedClaudeJs && isClaudeModule(moduleName)) {
      contentsBytes = modifiedClaudeJs;
      bytecodeBytes = clearBytecode
        ? Buffer.alloc(0)
        : getStringPointerContent(bunData, module.bytecode);
    } else {
      contentsBytes = getStringPointerContent(bunData, module.contents);
      bytecodeBytes = getStringPointerContent(bunData, module.bytecode);
    }

    const sourcemapBytes = getStringPointerContent(bunData, module.sourcemap);
    const moduleInfoBytes = getStringPointerContent(bunData, module.moduleInfo);
    const bytecodeOriginPathBytes = getStringPointerContent(
      bunData,
      module.bytecodeOriginPath
    );

    modulesMetadata.push({
      name: nameBytes,
      contents: contentsBytes,
      sourcemap: sourcemapBytes,
      bytecode: bytecodeBytes,
      moduleInfo: moduleInfoBytes,
      bytecodeOriginPath: bytecodeOriginPathBytes,
      encoding: module.encoding,
      loader: module.loader,
      moduleFormat: module.moduleFormat,
      side: module.side,
    });

    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      stringsData.push(
        nameBytes,
        contentsBytes,
        sourcemapBytes,
        bytecodeBytes,
        moduleInfoBytes,
        bytecodeOriginPathBytes
      );
    } else {
      stringsData.push(nameBytes, contentsBytes, sourcemapBytes, bytecodeBytes);
    }
    return undefined;
  });

  const stringsPerModule = moduleStructSize === SIZEOF_MODULE_NEW ? 6 : 4;

  // Phase 2: Calculate buffer layout
  let currentOffset = 0;
  const stringOffsets: StringPointer[] = [];

  // Allocate space for strings with null terminators
  for (const stringData of stringsData) {
    stringOffsets.push({ offset: currentOffset, length: stringData.length });
    currentOffset += stringData.length + 1; // +1 for null terminator
  }

  // Module structures
  const modulesListOffset = currentOffset;
  const modulesListSize = modulesMetadata.length * moduleStructSize;
  currentOffset += modulesListSize;

  // compileExecArgv
  const compileExecArgvBytes = getStringPointerContent(
    bunData,
    bunOffsets.compileExecArgvPtr
  );
  const compileExecArgvOffset = currentOffset;
  const compileExecArgvLength = compileExecArgvBytes.length;
  currentOffset += compileExecArgvLength + 1; // +1 for null terminator

  // Offsets structure
  const offsetsOffset = currentOffset;
  currentOffset += SIZEOF_OFFSETS;

  // Trailer
  const trailerOffset = currentOffset;
  currentOffset += BUN_TRAILER.length;

  // Phase 3: Build the new buffer
  const newBuffer = Buffer.allocUnsafe(currentOffset);
  newBuffer.fill(0);

  // Write all strings with null terminators
  let stringIdx = 0;
  for (const { offset, length } of stringOffsets) {
    if (length > 0) {
      stringsData[stringIdx].copy(newBuffer, offset, 0, length);
    }
    newBuffer[offset + length] = 0; // null terminator
    stringIdx++;
  }

  // Write compileExecArgv
  if (compileExecArgvLength > 0) {
    compileExecArgvBytes.copy(
      newBuffer,
      compileExecArgvOffset,
      0,
      compileExecArgvLength
    );
    newBuffer[compileExecArgvOffset + compileExecArgvLength] = 0;
  }

  // Build and write module structures
  for (let i = 0; i < modulesMetadata.length; i++) {
    const metadata = modulesMetadata[i];
    const baseStringIdx = i * stringsPerModule;

    const moduleStruct: BunModule = {
      name: stringOffsets[baseStringIdx],
      contents: stringOffsets[baseStringIdx + 1],
      sourcemap: stringOffsets[baseStringIdx + 2],
      bytecode: stringOffsets[baseStringIdx + 3],
      moduleInfo:
        moduleStructSize === SIZEOF_MODULE_NEW
          ? stringOffsets[baseStringIdx + 4]
          : { offset: 0, length: 0 },
      bytecodeOriginPath:
        moduleStructSize === SIZEOF_MODULE_NEW
          ? stringOffsets[baseStringIdx + 5]
          : { offset: 0, length: 0 },
      encoding: metadata.encoding,
      loader: metadata.loader,
      moduleFormat: metadata.moduleFormat,
      side: metadata.side,
    };

    // Serialize module structure inline
    const moduleOffset = modulesListOffset + i * moduleStructSize;
    let pos = moduleOffset;

    // Write StringPointers (common to both formats)
    newBuffer.writeUInt32LE(moduleStruct.name.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.name.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.contents.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.contents.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.sourcemap.length, pos + 4);
    pos += 8;
    newBuffer.writeUInt32LE(moduleStruct.bytecode.offset, pos);
    newBuffer.writeUInt32LE(moduleStruct.bytecode.length, pos + 4);
    pos += 8;

    // Write new-format-only StringPointers
    if (moduleStructSize === SIZEOF_MODULE_NEW) {
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.moduleInfo.length, pos + 4);
      pos += 8;
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.offset, pos);
      newBuffer.writeUInt32LE(moduleStruct.bytecodeOriginPath.length, pos + 4);
      pos += 8;
    }

    // Write enum fields
    newBuffer.writeUInt8(moduleStruct.encoding, pos);
    newBuffer.writeUInt8(moduleStruct.loader, pos + 1);
    newBuffer.writeUInt8(moduleStruct.moduleFormat, pos + 2);
    newBuffer.writeUInt8(moduleStruct.side, pos + 3);
  }

  // Build and write Offsets structure inline
  const newOffsets: BunOffsets = {
    byteCount: offsetsOffset,
    modulesPtr: {
      offset: modulesListOffset,
      length: modulesListSize,
    },
    entryPointId: bunOffsets.entryPointId,
    compileExecArgvPtr: {
      offset: compileExecArgvOffset,
      length: compileExecArgvLength,
    },
    flags: bunOffsets.flags,
  };

  let offsetsPos = offsetsOffset;
  const byteCount =
    typeof newOffsets.byteCount === 'bigint'
      ? newOffsets.byteCount
      : BigInt(newOffsets.byteCount);
  newBuffer.writeBigUInt64LE(byteCount, offsetsPos);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.modulesPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.entryPointId, offsetsPos);
  offsetsPos += 4;
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.offset, offsetsPos);
  newBuffer.writeUInt32LE(newOffsets.compileExecArgvPtr.length, offsetsPos + 4);
  offsetsPos += 8;
  newBuffer.writeUInt32LE(newOffsets.flags, offsetsPos);

  // Write trailer
  BUN_TRAILER.copy(newBuffer, trailerOffset);

  return newBuffer;
}

/**
 * Atomically writes a binary using LIEF and copies permissions from original.
 * Includes robust handling for busy/executing files.
 * @param binary - LIEF binary to write
 * @param outputPath - Target file path
 * @param originalPath - Original file to copy permissions from
 */
function atomicWriteBinary(
  binary: LIEF.ELF.Binary | LIEF.PE.Binary | LIEF.MachO.Binary,
  outputPath: string,
  originalPath: string,
  copyPermissions: boolean = true
): void {
  const tempPath = outputPath + '.tmp';
  binary.write(tempPath);

  if (copyPermissions) {
    const origStat = fs.statSync(originalPath);
    fs.chmodSync(tempPath, origStat.mode);
  }

  try {
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    // Check if it's a "file busy" / permission error when replacing the executable
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ETXTBSY' ||
        error.code === 'EBUSY' ||
        error.code === 'EPERM')
    ) {
      throw new Error(
        'Cannot update the Claude executable while it is running.\n' +
          'Please close all Claude instances and try again.'
      );
    }

    throw error;
  }
}

/**
 * Builds section data with size header followed by content.
 * Format: [size header][content]
 *
 * @param bunBuffer - The bun data buffer to wrap
 * @param headerSize - Header size: 4 for old format (Bun < 1.3.4), 8 for new format (default)
 */
function buildSectionData(bunBuffer: Buffer, headerSize: number = 8): Buffer {
  const sectionData = Buffer.allocUnsafe(headerSize + bunBuffer.length);
  if (headerSize === 8) {
    sectionData.writeBigUInt64LE(BigInt(bunBuffer.length), 0);
  } else {
    sectionData.writeUInt32LE(bunBuffer.length, 0);
  }
  bunBuffer.copy(sectionData, headerSize);
  return sectionData;
}

function repackMachO(
  machoBinary: LIEF.MachO.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    // CRITICAL: Remove code signature first - it will be invalidated by modifications
    debug(`repackMachO: Has code signature: ${machoBinary.hasCodeSignature}`);
    if (machoBinary.hasCodeSignature) {
      debug('repackMachO: Removing code signature...');
      machoBinary.removeSignature();
    }

    // Find __BUN segment and __bun section
    const bunSegment = machoBinary.getSegment('__BUN');
    if (!bunSegment) {
      throw new Error('__BUN segment not found');
    }

    const bunSection = bunSegment.getSection('__bun');
    if (!bunSection) {
      throw new Error('__bun section not found');
    }

    // Use the same header size as the original binary
    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);

    debug(`repackMachO: Original section size: ${bunSection.size}`);
    debug(`repackMachO: Original segment fileSize: ${bunSegment.fileSize}`);
    debug(
      `repackMachO: Original segment virtualSize: ${bunSegment.virtualSize}`
    );
    debug(`repackMachO: New data size: ${newSectionData.length}`);
    debug(`repackMachO: Using header size: ${sectionHeaderSize}`);

    // Calculate how much we need to expand
    const sizeDiff = newSectionData.length - Number(bunSection.size);

    if (sizeDiff > 0) {
      // CRITICAL: Round up to page alignment
      // See #180.
      // macOS requires segments to be page-aligned, otherwise __LINKEDIT becomes misaligned
      // Page size depends on architecture:
      // - x86_64: 4KB (4096 bytes)
      // - ARM64 (Apple Silicon): 16KB (16384 bytes)
      const isARM64 =
        machoBinary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64;
      const PAGE_SIZE = isARM64 ? 16384 : 4096;
      const alignedSizeDiff = Math.ceil(sizeDiff / PAGE_SIZE) * PAGE_SIZE;

      debug(`repackMachO: CPU type: ${isARM64 ? 'ARM64' : 'x86_64'}`);
      debug(`repackMachO: Page size: ${PAGE_SIZE} bytes`);
      debug(`repackMachO: Need to expand by ${sizeDiff} bytes`);
      debug(
        `repackMachO: Rounding up to page-aligned: ${alignedSizeDiff} bytes`
      );

      const success = machoBinary.extendSegment(bunSegment, alignedSizeDiff);
      debug(`repackMachO: extendSegment returned: ${success}`);

      if (!success) {
        throw new Error('Failed to extend __BUN segment');
      }

      debug(`repackMachO: Section size after extend: ${bunSection.size}`);
      debug(
        `repackMachO: Segment fileSize after extend: ${bunSegment.fileSize}`
      );
      debug(
        `repackMachO: Segment virtualSize after extend: ${bunSegment.virtualSize}`
      );
    }

    // Update section content
    bunSection.content = newSectionData;
    bunSection.size = BigInt(newSectionData.length);

    debug(`repackMachO: Final section size: ${bunSection.size}`);
    debug(`repackMachO: Writing modified binary to ${outputPath}...`);

    atomicWriteBinary(machoBinary, outputPath, binPath);

    // Re-sign the binary with an ad-hoc signature
    try {
      debug(`repackMachO: Re-signing binary with ad-hoc signature...`);
      execSync(`codesign -s - -f "${outputPath}"`, {
        stdio: isDebug() ? 'inherit' : 'ignore',
      });
      debug('repackMachO: Code signing completed successfully');
    } catch (codesignError) {
      console.warn(
        'Warning: Failed to re-sign binary. The binary may not run correctly on macOS:',
        codesignError
      );
    }

    debug('repackMachO: Write completed successfully');
  } catch (error) {
    console.error('repackMachO failed:', error);
    throw error;
  }
}

function repackPE(
  peBinary: LIEF.PE.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    const bunSection = peBinary.sections().find(s => s.name === '.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    // Use the same header size as the original binary
    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);

    debug(
      `repackPE: Original section size: ${bunSection.size}, virtual size: ${bunSection.virtualSize}`
    );
    debug(`repackPE: New data size: ${newSectionData.length}`);
    debug(`repackPE: Using header size: ${sectionHeaderSize}`);

    // Update section content
    bunSection.content = newSectionData;

    // Explicitly set both the virtual size AND the raw size
    // PE sections have both:
    // - size (raw size on disk, must be aligned to FileAlignment)
    // - virtualSize (size in memory when loaded)
    bunSection.virtualSize = BigInt(newSectionData.length);
    bunSection.size = BigInt(newSectionData.length);

    debug(`repackPE: Writing modified binary to ${outputPath}...`);
    atomicWriteBinary(peBinary, outputPath, binPath, false);
    debug('repackPE: Write completed successfully');
  } catch (error) {
    console.error('repackPE failed:', error);
    throw error;
  }
}

/**
 * Alignment constant used by BUN_COMPILED in c-bindings.cpp.
 * The BUN_COMPILED symbol is placed with __attribute__((aligned(BLOB_HEADER_ALIGNMENT))).
 */
const BLOB_HEADER_ALIGNMENT = 16384;

function alignBigInt(value: bigint, alignment: bigint): bigint {
  return ((value + alignment - 1n) / alignment) * alignment;
}

export interface BunSectionPlacement {
  newVaddr: bigint;
  newFileOffset: bigint;
  alignedNewSize: bigint;
  extensionSize: bigint;
  /** Placed directly after the writable segment (gap-free) rather than at nextVirtualAddress. */
  compact: boolean;
}

/**
 * Where to place the rebuilt `.bun` section inside the writable PT_LOAD.
 *
 * A PT_LOAD maps a CONTIGUOUS file -> vaddr range, and the writable segment is
 * extended to cover the new section — so every byte between the segment's
 * current end and the new section's vaddr becomes a real zero byte in the file.
 * LIEF's `nextVirtualAddress()` rounds up to a coarse boundary (the next 256 MB
 * here), which on a ~275 MB Claude Code binary padded the output with roughly
 * 427 MB of zeroes.
 *
 * When the writable segment is the TOPMOST LOAD segment the section can instead
 * go immediately after it, page-aligned, with no gap at all. That is only safe
 * when nothing is mapped above it — otherwise extending the segment would
 * overlap a higher one — so anything else falls back to the original placement.
 *
 * `topmostLoadEnd` must be max(vaddr + memsz) across every LOAD segment, and
 * `rwVirtualSize` must be the MEMORY size, so a BSS tail is not mistaken for
 * file content.
 *
 * ELF-only, so it changes nothing on macOS. Kept as a pure function of its
 * inputs precisely so the arithmetic is testable without a Linux binary.
 * Ported from upstream b36a8ca (#915).
 */
export function computeBunSectionPlacement(params: {
  rwVirtualAddress: bigint;
  rwVirtualSize: bigint;
  rwFileOffset: bigint;
  rwFileSize: bigint;
  topmostLoadEnd: bigint;
  nextVirtualAddress: bigint;
  newContentSize: bigint;
  pageSize: bigint;
}): BunSectionPlacement {
  const {
    rwVirtualAddress,
    rwVirtualSize,
    rwFileOffset,
    rwFileSize,
    topmostLoadEnd,
    nextVirtualAddress,
    newContentSize,
    pageSize,
  } = params;

  const alignedNewSize = alignBigInt(newContentSize, pageSize);
  const rwMemEnd = rwVirtualAddress + rwVirtualSize;
  const compact = rwMemEnd >= topmostLoadEnd;
  const newVaddr = compact
    ? alignBigInt(rwMemEnd, pageSize)
    : alignBigInt(nextVirtualAddress, pageSize);

  const offsetInSegment = newVaddr - rwVirtualAddress;
  const newFileOffset = rwFileOffset + offsetInSegment;
  const oldRwFileEnd = rwFileOffset + rwFileSize;
  const extensionSize = newFileOffset + alignedNewSize - oldRwFileEnd;

  return { newVaddr, newFileOffset, alignedNewSize, extensionSize, compact };
}

/**
 * Repack an ELF binary that uses the new .bun section format (post-PR#26923).
 *
 * The .bun section uses the same [u64 payload_len][payload] format as macOS/PE.
 * At build time, Bun's writeBunSection() creates a PT_LOAD segment to map the
 * .bun section data, and stores the segment's vaddr in the BUN_COMPILED symbol
 * (located at its original position in the RW data segment). At runtime, the
 * Bun runtime reads BUN_COMPILED.size as a vaddr pointer to the mapped data.
 *
 * On repack we need to:
 * 1. Set the .bun section content (LIEF handles file layout)
 * 2. Update the PT_LOAD segment's fileSize/virtualSize to cover the new data
 * 3. Patch BUN_COMPILED.size with the (possibly unchanged) vaddr
 */
function repackELFSection(
  elfBinary: LIEF.ELF.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string,
  sectionHeaderSize: number
): void {
  try {
    const bunSection = elfBinary.getSection('.bun');
    if (!bunSection) {
      throw new Error('.bun section not found');
    }

    const rwSegment = elfBinary
      .segments()
      .find(s => s.type === 'LOAD' && (s.flags & 2) !== 0);
    if (!rwSegment) {
      throw new Error('No writable ELF PT_LOAD segment found');
    }

    const newSectionData = buildSectionData(newBunBuffer, sectionHeaderSize);
    const oldBunSectionVaddr = bunSection.virtualAddress;
    const vaddrBytes = Buffer.alloc(8);
    vaddrBytes.writeBigUInt64LE(oldBunSectionVaddr);

    let bunCompiledVaddr: bigint | null = null;
    const rwContent = rwSegment.content;
    const rwVaddrStart = rwSegment.virtualAddress;
    const firstAligned = alignBigInt(
      rwVaddrStart,
      BigInt(BLOB_HEADER_ALIGNMENT)
    );
    const lastCandidate = rwVaddrStart + BigInt(rwContent.length) - 8n;

    for (
      let va = firstAligned;
      va <= lastCandidate;
      va += BigInt(BLOB_HEADER_ALIGNMENT)
    ) {
      const off = Number(va - rwVaddrStart);
      if (rwContent.subarray(off, off + 8).equals(vaddrBytes)) {
        bunCompiledVaddr = va;
        break;
      }
    }

    if (bunCompiledVaddr === null) {
      throw new Error(
        `Could not find original BUN_COMPILED location in binary (searched for 0x${oldBunSectionVaddr.toString(16)})`
      );
    }

    const pageSize = elfBinary.pageSize();
    const newContentSize = BigInt(newSectionData.length);
    // Place the rebuilt .bun right after the writable segment when that segment
    // is the topmost LOAD, instead of at LIEF's nextVirtualAddress() — which
    // rounds to a coarse boundary and pads the file with ~427 MB of zeroes,
    // since the extended PT_LOAD has to cover the whole span contiguously.
    const loadSegments = elfBinary.segments().filter(s => s.type === 'LOAD');
    const topmostLoadEnd = loadSegments.reduce((max, s) => {
      const end = BigInt(s.virtualAddress) + BigInt(s.virtualSize);
      return end > max ? end : max;
    }, 0n);

    const placement = computeBunSectionPlacement({
      rwVirtualAddress: BigInt(rwSegment.virtualAddress),
      rwVirtualSize: BigInt(rwSegment.virtualSize),
      rwFileOffset: BigInt(rwSegment.fileOffset),
      rwFileSize: BigInt(rwSegment.fileSize),
      topmostLoadEnd,
      nextVirtualAddress: BigInt(elfBinary.nextVirtualAddress()),
      newContentSize,
      pageSize: BigInt(pageSize),
    });
    const { newVaddr, newFileOffset, extensionSize, compact } = placement;
    debug(
      `repackELFSection: ${compact ? 'compact' : 'fallback'} placement ` +
        `(topmost LOAD ends at 0x${topmostLoadEnd.toString(16)})`
    );

    if (extensionSize < 0n) {
      throw new Error(
        'New .bun location overlaps existing writable ELF segment'
      );
    }

    debug(
      `repackELFSection: moving .bun to offset=0x${newFileOffset.toString(16)}, vaddr=0x${newVaddr.toString(16)}, size=0x${newContentSize.toString(16)}`
    );

    if (extensionSize > 0n) {
      const extendedSegment = elfBinary.extend(rwSegment, extensionSize);
      if (!extendedSegment) {
        throw new Error('Failed to extend writable ELF PT_LOAD segment');
      }
    }

    bunSection.fileOffset = newFileOffset;
    bunSection.virtualAddress = newVaddr;
    bunSection.content = newSectionData;
    bunSection.size = newContentSize;

    const vaddrPatch = Buffer.alloc(8);
    vaddrPatch.writeBigUInt64LE(newVaddr);
    elfBinary.patchAddress(bunCompiledVaddr, vaddrPatch);

    debug(
      `repackELFSection: Patched BUN_COMPILED at vaddr 0x${bunCompiledVaddr.toString(16)} -> 0x${newVaddr.toString(16)}`
    );

    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug('repackELFSection: Write completed successfully');
  } catch (error) {
    console.error('repackELFSection failed:', error);
    throw error;
  }
}

/**
 * Legacy ELF repack: data is appended as an overlay (pre-PR#26923).
 */
function repackELFOverlay(
  elfBinary: LIEF.ELF.Binary,
  binPath: string,
  newBunBuffer: Buffer,
  outputPath: string
): void {
  try {
    // Build new overlay: [bunData][totalByteCount (8 bytes)]
    // Note: newBunBuffer already includes offsets and trailer
    const newOverlay = Buffer.allocUnsafe(newBunBuffer.length + 8);
    newBunBuffer.copy(newOverlay, 0);
    newOverlay.writeBigUInt64LE(
      BigInt(newBunBuffer.length),
      newBunBuffer.length
    );

    debug(
      `repackELFOverlay: Setting overlay data (${newOverlay.length} bytes)`
    );

    elfBinary.overlay = newOverlay;
    debug(`repackELFOverlay: Writing modified binary to ${outputPath}...`);

    atomicWriteBinary(elfBinary, outputPath, binPath);
    debug('repackELFOverlay: Write completed successfully');
  } catch (error) {
    console.error('repackELFOverlay failed:', error);
    throw error;
  }
}

/**
 * Repacks a modified claude.js back into the native installation binary.
 *
 * Note: If the binary might be a Nix `makeBinaryWrapper` wrapper, callers
 * should resolve it first using `resolveNixBinaryWrapper()` and pass the
 * real binary path here. This is handled at detection time in
 * `installationDetection.ts`, so `nativeInstallationPath` should already
 * point to the real binary.
 *
 * @param binPath - Path to the original native installation binary
 * @param modifiedClaudeJs - Modified claude.js contents as a Buffer
 * @param outputPath - Where to write the repacked binary
 */
export function repackNativeInstallation(
  binPath: string,
  modifiedClaudeJs: Buffer,
  outputPath: string,
  clearBytecode: boolean
): void {
  LIEF.logging.disable();
  const binary = LIEF.parse(binPath);

  const bundle = locateBundle(binary, binPath);

  // A virtual bundle (CC 2.1.246+) carries its own module boundaries. Split it
  // back into per-module contents; a pre-2.1.246 single module parses as null
  // and takes the legacy path untouched.
  const moduleOverrides = parseSentinelBundle(modifiedClaudeJs);

  if (moduleOverrides) {
    // A patch that deleted or fabricated a sentinel would silently merge two
    // modules' source into one. Fail loudly instead: the set of indices in the
    // bundle must be exactly the set of patchable JS modules in the binary.
    const expected = new Set<number>();
    mapModules(
      bundle.bunData,
      bundle.bunOffsets,
      bundle.moduleStructSize,
      (module, moduleName, index) => {
        if (module.contents.length <= 0) return undefined;
        if (
          isPatchableJsModule(
            moduleName,
            module.contents.length,
            getStringPointerContent(bundle.bunData, module.contents)
          )
        ) {
          expected.add(index);
        }
        return undefined;
      }
    );
    const missing = [...expected].filter(i => !moduleOverrides.has(i));
    const extra = [...moduleOverrides.keys()].filter(i => !expected.has(i));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `repackNativeInstallation: module sentinel mismatch — ` +
          `${missing.length} missing (${missing.slice(0, 5).join(', ')}), ` +
          `${extra.length} unexpected (${extra.slice(0, 5).join(', ')}). ` +
          `A patch most likely deleted a /*@@TWEAKCC_MODULE:@@*/ boundary.`
      );
    }
  }

  const newBuffer = moduleOverrides
    ? rebuildBunDataAppendOnly(
        bundle.bunData,
        bundle.bunOffsets,
        bundle.moduleStructSize,
        moduleOverrides
      )
    : rebuildBunData(
        bundle.bunData,
        bundle.bunOffsets,
        modifiedClaudeJs,
        bundle.moduleStructSize,
        clearBytecode
      );

  bundle.write(newBuffer, outputPath);
}
