import { describe, it, expect } from 'vitest';
import { writeAgentsMd } from './agentsMd';

const mockFunction =
  'function _t7(A,q){try{let K=x1();' +
  'if(!K.existsSync(A)||!K.statSync(A).isFile())return null;' +
  'let Y=UL9(A).toLowerCase();' +
  'if(Y&&!dL9.has(Y))' +
  'return(I(`Skipping non-text file in @include: ${A}`),null);' +
  'let z=K.readFileSync(A,{encoding:"utf-8"}),' +
  '{content:w,paths:H}=cL9(z);' +
  'return{path:A,type:q,content:w,globs:H};' +
  '}catch(K){' +
  'if(K instanceof Error&&K.message.includes("EACCES"))' +
  'n("tengu_claude_md_permission_error",{is_access_error:1});' +
  '}return null;}';

const altNames = ['AGENTS.md', 'GEMINI.md', 'QWEN.md'];

describe('agentsMd', () => {
  describe('writeAgentsMd', () => {
    it('should inject fallback at early return null when CLAUDE.md is missing', () => {
      const result = writeAgentsMd(mockFunction, altNames);
      expect(result).not.toBeNull();
      expect(result).toContain('didReroute');
      expect(result).toContain('endsWith("/CLAUDE.md")');
      expect(result).toContain('AGENTS.md');
      expect(result).toMatch(/\.isFile\(\)\)\{.*?return null;\}/);
    });

    it('should preserve CLAUDE.md content when present', () => {
      const result = writeAgentsMd(mockFunction, altNames)!;
      const returnIdx = result.indexOf('return{path:');
      expect(returnIdx).toBeGreaterThan(-1);
      const beforeReturn = result.slice(Math.max(0, returnIdx - 50), returnIdx);
      expect(beforeReturn).not.toContain('didReroute');
    });

    it('should pass didReroute=true in recursive calls', () => {
      const result = writeAgentsMd(mockFunction, altNames)!;
      expect(result).toContain('return _t7(altPath,q,true)');
    });

    it('should return null when no alternatives are found', () => {
      const result = writeAgentsMd(mockFunction, altNames)!;
      expect(result).toMatch(/\}return null;\}/);
    });

    it('should add didReroute parameter to function signature', () => {
      const result = writeAgentsMd(mockFunction, altNames)!;
      expect(result).toContain('function _t7(A,q,didReroute)');
    });

    it('should use the correct fs expression', () => {
      const result = writeAgentsMd(mockFunction, altNames)!;
      expect(result).toContain('K.existsSync(altPath)');
      expect(result).toContain('K.statSync(altPath)');
    });

    it('should return null when function pattern is not found', () => {
      const result = writeAgentsMd('not a valid file', altNames);
      expect(result).toBeNull();
    });
  });

  // CC >=2.1.196: the async reader was refactored to a helper that returns null
  // on failure (no try/catch readFile). The not-found path is the `o===null`
  // branch, so the AGENTS.md reroute goes there.
  describe('writeAgentsMd async null-check shape (CC >=2.1.196)', () => {
    const nullCheckReader =
      'async function Uca(e,t,n){try{let r=Vt(),o=await qN(r,e,Gao);' +
      'if(o===null)return C(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${Gao} byte limit`),{info:null,includePaths:[]};' +
      'return mpp(o,e,t,n)}catch(r){return hpp(r,e),{info:null,includePaths:[]}}}';

    it('adds didReroute to the signature and reroutes in the o===null branch', () => {
      const result = writeAgentsMd(nullCheckReader, altNames);
      expect(result).not.toBeNull();
      expect(result).toContain('async function Uca(e,t,n,didReroute)');
      expect(result).toContain('if(o===null){');
      expect(result).toContain('endsWith("/CLAUDE.md")');
      expect(result).toContain('AGENTS.md');
    });

    it('recurses with didReroute=true and a non-colliding result var', () => {
      const result = writeAgentsMd(nullCheckReader, altNames)!;
      expect(result).toContain('await Uca(altPath,t,n,true)');
      // The try block already declares `r` (ctx), so the loop must not redeclare it.
      expect(result).toContain('let rerouteResult=await Uca(altPath,t,n,true)');
      expect(result).not.toContain('let r=await Uca');
    });

    it('preserves the skip-return, processor call, and catch verbatim', () => {
      const result = writeAgentsMd(nullCheckReader, altNames)!;
      expect(result).toContain(
        'return C(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${Gao} byte limit`),{info:null,includePaths:[]};}'
      );
      expect(result).toContain('return mpp(o,e,t,n)');
      expect(result).toContain(
        'catch(r){return hpp(r,e),{info:null,includePaths:[]}}'
      );
    });
  });

  // CC >=2.1.210: the async reader gained an isDirectory() probe — a 4th
  // callback arg to the reader and an extra `o=!1` dir flag — and the
  // not-found path became a braced compound block (`if(i===null){...}`) that
  // logs a skip, records a metric, then returns {info:null,includePaths:[]}.
  describe('writeAgentsMd async dir-flag shape (CC >=2.1.210)', () => {
    const dirFlagReader =
      'async function _Kc(e,t,r){try{let n=Jt(),o=!1,i=await Zq(n,e,cKc,(s)=>{o=s.isDirectory()});' +
      'if(i===null){if(C(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${cKc} byte limit`),!pKc&&!o)pKc=!0,We("context_claude_md_load","file_skipped_special_or_oversize");return{info:null,includePaths:[]}}' +
      'return rrg(i,e,t,r)}catch(n){return org(n,e),{info:null,includePaths:[]}}}';

    it('adds didReroute to the signature and reroutes in the i===null branch', () => {
      const result = writeAgentsMd(dirFlagReader, altNames);
      expect(result).not.toBeNull();
      expect(result).toContain('async function _Kc(e,t,r,didReroute)');
      expect(result).toContain('if(i===null){');
      expect(result).toContain('endsWith("/CLAUDE.md")');
      expect(result).toContain('AGENTS.md');
    });

    it('recurses with didReroute=true and a non-colliding result var', () => {
      const result = writeAgentsMd(dirFlagReader, altNames)!;
      expect(result).toContain('await _Kc(altPath,t,r,true)');
      expect(result).toContain('let rerouteResult=await _Kc(altPath,t,r,true)');
      // The try block already declares `n` (ctx); the loop must not redeclare it.
      expect(result).not.toContain('let n=await _Kc');
    });

    it('preserves the reader dir-flag probe, skip body, processor, and catch verbatim', () => {
      const result = writeAgentsMd(dirFlagReader, altNames)!;
      expect(result).toContain(
        'let n=Jt(),o=!1,i=await Zq(n,e,cKc,(s)=>{o=s.isDirectory()})'
      );
      expect(result).toContain(
        'if(C(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${cKc} byte limit`),!pKc&&!o)pKc=!0,We("context_claude_md_load","file_skipped_special_or_oversize");return{info:null,includePaths:[]}}'
      );
      expect(result).toContain('return rrg(i,e,t,r)');
      expect(result).toContain(
        'catch(n){return org(n,e),{info:null,includePaths:[]}}'
      );
    });
  });
});
