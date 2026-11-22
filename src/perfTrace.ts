import crypto from 'node:crypto';
import fs from 'node:fs';

export interface PerfTrace {
  emit(kind: string, record: Record<string, unknown>): void;
  digest(text: string): string;
  clip(text: string): string;
}

const MAX_STRING = 200;

const openTrace = (file: string): PerfTrace => {
  const fd = fs.openSync(file, 'a');
  let seq = 0;
  return {
    emit(kind, record) {
      fs.writeSync(
        fd,
        JSON.stringify({ k: kind, pid: process.pid, seq: seq++, ...record }) +
          '\n'
      );
    },
    digest: text =>
      crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
    clip: text => (text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text),
  };
};

export const TRACE: PerfTrace | null = process.env.TWEAKCC_PERF_TRACE
  ? openTrace(process.env.TWEAKCC_PERF_TRACE)
  : null;

export const SHADOW: boolean = process.env.TWEAKCC_PERF_SHADOW === '1';

export const shadowFail = (
  check: string,
  detail: Record<string, unknown>
): never => {
  if (TRACE) TRACE.emit('shadow-fail', { check, ...detail });
  process.stderr.write(
    `tweakcc perf shadow mismatch (${check}): ${JSON.stringify(detail)}\n`
  );
  process.exit(86);
};

export const matchListDigest = (
  trace: PerfTrace,
  matches: RegExpExecArray[]
): Array<[number, number, string]> =>
  matches.map(m => [
    m.index,
    m[0].length,
    trace.digest(JSON.stringify(Array.from(m).slice(1))),
  ]);
