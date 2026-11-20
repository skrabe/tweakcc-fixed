import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildEverythingGlobRuntime,
  writeEverythingGlob,
} from './everythingGlob';

vi.mock('./index', () => ({ showDiff: () => {} }));

const ES = 'C:\\tools\\es.exe';

// trimmed from CC 2.1.323's Glob search function
const FRAGMENT =
  'async function vPr(e,n,{limit:r,offset:s},h,y,k){let v=e.canonical,L=fln(y),q=kOr(L,e),' +
  'Ee=["--files","--null","--glob",n,"--sort=modified","--no-ignore","--hidden"];let ve=null,Ce,xe=!1;' +
  '{let gt=k?.mark("external"),wt=await hJ(Ee,e.target,h,{rawLines:!0,rejectOnInputError:!0,searchOtherAppsData:!0,' +
  'cwd:e.spawnCwd,spawnDirFd:e.spawnDirFd,inheritFd:e.inheritFd,beforeSpawn:()=>{e.recheckBeforeSpawn(),Eko(L,e,q)}})' +
  '.then((bt)=>({lines:bt,timedOut:!1})).finally(gt);xe=wt.timedOut,Ce=xko(wt.lines,"files_with_matches")}' +
  'let He=e.judgeEveryResult===!0;return{files:Ce,He}}';

describe('writeEverythingGlob', () => {
  it('routes the Glob rg call through the Everything runtime', () => {
    const out = writeEverythingGlob(FRAGMENT, ES)!;
    expect(out).toContain(
      '=await (globalThis.__tweakccEverythingGlob??=(async(rg,state,args,target,signal,opts)=>{'
    );
    expect(out).toContain(
      '(hJ,e,Ee,e.target,h,{rawLines:!0,rejectOnInputError:!0,searchOtherAppsData:!0,cwd:e.spawnCwd,'
    );
    expect(out).toContain(JSON.stringify(ES));
    // the String.raw runtime has regexes and backslashes; make sure it still parses
    expect(() => new Function(out)).not.toThrow();
  });

  it('is a no-op the second time', () => {
    const once = writeEverythingGlob(FRAGMENT, ES)!;
    expect(writeEverythingGlob(once, ES)).toBe(once);
  });

  it('returns null when the call shape changed', () => {
    const changed = FRAGMENT.replace('searchOtherAppsData:!0,', '');
    expect(writeEverythingGlob(changed, ES)).toBeNull();
  });
});

const onPath = (exe: string): string | null => {
  const r = spawnSync('where.exe', [exe], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};
const esPath = process.platform === 'win32' ? onPath('es.exe') : null;
const canCompare =
  esPath !== null && onPath('bun') !== null && onPath('rg') !== null;

// Same file list rg would give CC, or the Everything path leaks or loses files.
// rg runs the way CC's Windows Glob runs it: cwd is the project root, the
// search target is a subfolder, so anchored globs are relative to the root.
describe.skipIf(!canCompare)('Everything runtime vs ripgrep', () => {
  const FILES = [
    'top.txt',
    'a.ts',
    'sub/a.ts',
    'sub/b.md',
    'sub/keep.ts',
    'sub/.hidden.ts',
    'sub/héllo wörld.ts',
    'sub/deep/c.ts',
    'sub/deep/c.md',
    'sub/secret/key.ts',
    'sub/node_modules/x/d.ts',
    'sub/MixedCase/E.TS',
    'sub/MixedCase/f.ts',
    'sub/other/g.ts',
  ];
  const BASE = ['--files', '--null'];
  const TAIL = ['--sort=modified', '--no-ignore', '--hidden'];
  const CASES: string[][] = [
    ['--glob', '*.ts'],
    ['--glob', '/sub/**/*.ts'],
    ['--glob', '/sub/deep/*'],
    ['--glob', '**/*.{ts,md}'],
    ['--glob', '*.ts', '--iglob', '!/sub/secret/**'],
    ['--glob', '*.ts', '--iglob', '!**/node_modules'],
    ['--glob', '*.ts', '--iglob', '!**/node_modules/**'],
    ['--glob', '*.TS'],
    ['--glob', '*.ts', '--iglob', '!**/mixedcase/**'],
    ['--glob', '*.ts', '--glob', '!**/deep/**', '--glob', '**/deep/c.ts'],
    ['--glob', '*.ts', '--glob', '!**'],
    ['--glob', '!*.md'],
  ].map(([flag, main, ...rest]) => [...BASE, flag, main, ...TAIL, ...rest]);

  it('lists the same files for every glob set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tweakcc-es-diff-'));
    try {
      // mtimes run opposite to FILES order, so a name-sorted answer can't
      // pass for rg's --sort=modified one
      const base = Date.now() / 1000 - 3600;
      FILES.forEach((rel, i) => {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '');
        const t = base + (FILES.length - i) * 60;
        fs.utimesSync(full, t, t);
      });
      const target = path.join(root, 'sub');
      const oldest = path.join(root, FILES[FILES.length - 1]);
      const newest = path.join(root, FILES[0]);

      const deadline = Date.now() + 15000;
      for (;;) {
        const listed = spawnSync(
          esPath!,
          ['-path', root + '\\', '/a-d', '-sort', 'date-modified-ascending'],
          { encoding: 'utf8' }
        )
          .stdout.split(/\r?\n/)
          .filter(Boolean);
        if (
          listed.length === FILES.length &&
          listed[0] === oldest &&
          listed[listed.length - 1] === newest
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Everything never indexed the fixture (saw ${listed.length} files)`
          );
        }
        spawnSync('powershell.exe', ['-c', 'Start-Sleep -m 200']);
      }

      const script = path.join(root, '..', path.basename(root) + '.mjs');
      fs.writeFileSync(
        script,
        `const run=${buildEverythingGlobRuntime(esPath!)};\n` +
          'const [cases,target,cwd]=JSON.parse(process.argv[2]);const out=[];\n' +
          'for(const args of cases){const state={};\n' +
          'const files=await run(()=>{throw new Error("fell back to rg")},state,args,target,new AbortController().signal,{cwd,beforeSpawn(){}});\n' +
          'out.push({files,judged:state.judgeEveryResult})}\n' +
          'console.log(JSON.stringify(out));\n'
      );
      try {
        const bun = spawnSync(
          'bun',
          [script, JSON.stringify([CASES, target, root])],
          { encoding: 'utf8' }
        );
        expect(bun.stderr).toBe('');
        const results: { files: string[]; judged: boolean }[] = JSON.parse(
          bun.stdout
        );

        CASES.forEach((args, i) => {
          const rg = spawnSync('rg', [...args, target], { cwd: root });
          const expected = rg.stdout
            .toString('utf8')
            .split('\0')
            .filter(Boolean);
          expect({ args, files: results[i].files }).toEqual({
            args,
            files: expected,
          });
          expect(results[i].judged).toBe(true);
        });
      } finally {
        fs.rmSync(script, { force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
