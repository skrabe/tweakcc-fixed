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

  describe('writeAgentsMd async backend shape (CC 2.1.276)', () => {
    // The reader as 2.1.276 ships it: a storage-backend read whose switch
    // returns on its own for absent and error, a plain-path read that stats
    // first (so a missing file throws into the catch), and the null branch
    // reached only by the skipped cases.
    const backendReader =
      'async function x7e(e,n,r,s){try{let g,h=!1;if(s){let y=await Uwo(s);switch(y.kind){' +
      'case"absent":return{info:null,includePaths:[]};' +
      'case"error":return Xtn(y.code,e),{info:null,includePaths:[]};' +
      'case"skipped":h=y.isDirectory,g=null;break;case"content":g=y.content;break}}' +
      'else{let y=le();g=await uA(y,e,rxe,(w)=>{h=w.isDirectory()})}' +
      'if(g===null){t(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${rxe} byte limit`);let y=T7e();if(!y.skip&&!h)y.skip=!0,f("context_claude_md_load","file_skipped_special_or_oversize");return{info:null,includePaths:[]}}' +
      'return Gtn(g,e,n,r)}catch(g){return Bwo(g,e),{info:null,includePaths:[]}}}';

    it('reroutes at the backend absent arm', () => {
      const result = writeAgentsMd(backendReader, altNames)!;
      expect(result).not.toBeNull();
      expect(result).toContain('async function x7e(e,n,r,s,didReroute)');
      expect(result).toContain(
        'case"absent":{if(!didReroute&&(e.endsWith("/CLAUDE.md")'
      );
      expect(result).toContain(
        'return{info:null,includePaths:[]}};case"error"'
      );
    });

    it('reroutes at the backend error arm only for a missing path, and keeps the handler', () => {
      const result = writeAgentsMd(backendReader, altNames)!;
      expect(result).toContain(
        'case"error":{if(!didReroute&&(y.code==="ENOENT"||y.code==="ENOTDIR")){'
      );
      expect(result).toContain(
        'return Xtn(y.code,e),{info:null,includePaths:[]}};case"skipped"'
      );
    });

    it('reroutes from the catch when the plain-path stat threw ENOENT', () => {
      const result = writeAgentsMd(backendReader, altNames)!;
      expect(result).toContain(
        'catch(g){if(!didReroute&&g&&(g.code==="ENOENT"||g.code==="ENOTDIR")){'
      );
      expect(result).toContain('return Bwo(g,e),{info:null,includePaths:[]}}}');
    });

    it('recurses through the plain-path branch with didReroute=true, and keeps the null branch', () => {
      const result = writeAgentsMd(backendReader, altNames)!;
      expect(result).toContain(
        'let rerouteResult=await x7e(altPath,n,r,void 0,true)'
      );
      expect(result).toContain('if(g===null){if(!didReroute');
      expect(result).toContain(
        't(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${rxe} byte limit`)'
      );
      expect(result).toContain('return Gtn(g,e,n,r)');
    });

    it('leaves a build without the 2.1.278 walk untouched beyond the reader', () => {
      const result = writeAgentsMd(backendReader, altNames)!;
      expect(result).not.toContain('found.length');
    });
  });

  describe('writeAgentsMd walk pre-check (CC >=2.1.278)', () => {
    // The memory walk as 2.1.278 ships it: candidate paths that an lstat walk
    // found missing sit in `Ot`, and both sites route such a path to `WRt`
    // (mark processed, return nothing) without calling the loader `k4`.
    const backendReader =
      'async function x7e(e,n,r,s){try{let g,h=!1;if(s){let y=await Uwo(s);switch(y.kind){' +
      'case"absent":return{info:null,includePaths:[]};' +
      'case"error":return Xtn(y.code,e),{info:null,includePaths:[]};' +
      'case"skipped":h=y.isDirectory,g=null;break;case"content":g=y.content;break}}' +
      'else{let y=le();g=await uA(y,e,rxe,(w)=>{h=w.isDirectory()})}' +
      'if(g===null){t(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${rxe} byte limit`);return{info:null,includePaths:[]}}' +
      'return Gtn(g,e,n,r)}catch(g){return Bwo(g,e),{info:null,includePaths:[]}}}';
    const walk =
      'V$t=async(bn,Nn)=>Ot.has(bn)?WRt(bn,Nn,B,_e):k4(bn,Nn,B,he,0,void 0,void 0,_e);' +
      'L.push(...await V$t(ve,"Managed"));' +
      'if(Ie){if(L.push(...Ot.has(Oe)?WRt(Oe,"User",B,_e):await k4(Oe,"User",B,!0,0,void 0,g!==void 0?{backend:g,key:Ae.state("user-memory")}:void 0,_e)),!Ot.has(Fe))L.push(...await zTe({rulesDir:Fe}))}';
    const file = backendReader + ';' + walk;

    it('tries the alternative names through the loader before marking a missing project file', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).toContain(
        'V$t=async(bn,Nn)=>{if(Ot.has(bn)){if(bn.endsWith("/CLAUDE.md")||bn.endsWith("\\\\CLAUDE.md")){'
      );
      expect(result).toContain(
        'let found=await k4(altPath,Nn,B,he,0,void 0,void 0,_e);if(found.length)return found'
      );
      expect(result).toContain('return WRt(bn,Nn,B,_e)}');
      expect(result).toContain('return k4(bn,Nn,B,he,0,void 0,void 0,_e)}');
    });

    it('tries the alternative names for the user file without the storage descriptor', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).toContain('Ot.has(Oe)?await(async()=>{');
      expect(result).toContain(
        'let found=await k4(altPath,"User",B,!0,0,void 0,void 0,_e);if(found.length)return found'
      );
      expect(result).toContain('return WRt(Oe,"User",B,_e)})()');
      expect(result).toContain(
        ':await k4(Oe,"User",B,!0,0,void 0,g!==void 0?{backend:g,key:Ae.state("user-memory")}:void 0,_e)'
      );
    });

    it('still patches the reader beside the walk', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).toContain('async function x7e(e,n,r,s,didReroute)');
      expect(result).toContain('case"absent":{if(!didReroute');
    });

    it.each([
      walk.slice(0, walk.indexOf(';') + 1),
      walk.slice(walk.indexOf(';') + 1),
    ])('returns null when only one walk site is present', site => {
      expect(writeAgentsMd(backendReader + ';' + site, altNames)).toBeNull();
    });
  });
  describe('writeAgentsMd custom-reader shape (CC >=2.1.291)', () => {
    const reader =
      'async function gMe(e,n,r,s,g){try{let h,b=!1;if(g){let w=await g(e,ZB);return w===void 0?{info:null,includePaths:[]}:mMe(w,e,n,r)}' +
      'if(s){let w=await A3n(s);switch(w.kind){' +
      'case"absent":return{info:null,includePaths:[]};' +
      'case"error":return Okt(w.code,e),{info:null,includePaths:[]};' +
      'case"skipped":b=w.isDirectory,h=null;break;case"content":h=w.content;break}}' +
      'else{let w=oe();h=await _H(w,e,ZB,(M)=>{b=M.isDirectory()})}' +
      'if(h===null){t(`[CLAUDE.md] skipping ${e}: not a regular file or exceeds ${ZB} byte limit`);return{info:null,includePaths:[]}}' +
      'return mMe(h,e,n,r)}catch(h){return x3n(h,e),{info:null,includePaths:[]}}}';
    const walk =
      'hn=async(ln,Kn,eo)=>Wt.has(ln)?vkt(ln,Kn,V,_e):XF(ln,Kn,V,he,0,void 0,void 0,_e,eo);' +
      'W.push(...await hn(Se,"Managed"));' +
      'if(Ce){if(W.push(...Wt.has(Ne)?vkt(Ne,"User",V,_e):await XF(Ne,"User",V,!0,0,void 0,g!==void 0?{backend:g,key:De.state("user-memory")}:void 0,_e)),!Wt.has(Ue))W.push(...await _oe({rulesDir:Ue}))}';
    const file = reader + ';' + walk;

    it('keeps the custom-reader branch and appends didReroute after it', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).not.toBeNull();
      expect(result).toContain(
        'async function gMe(e,n,r,s,g,didReroute){try{let h,b=!1;if(g){let w=await g(e,ZB);if(w===void 0&&!didReroute'
      );
      expect(result).toContain(
        'return w===void 0?{info:null,includePaths:[]}:mMe(w,e,n,r)}if(s){'
      );
      expect(result).toContain('case"absent":{if(!didReroute');
      expect(result).toContain(
        'let rerouteResult=await gMe(altPath,n,r,void 0,void 0,true)'
      );
    });

    it('reroutes inside the custom-reader branch through the same reader', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).toContain(
        'if(g){let w=await g(e,ZB);if(w===void 0&&!didReroute&&(e.endsWith("/CLAUDE.md")||e.endsWith("\\\\CLAUDE.md"))){for(let alt of ["AGENTS.md"'
      );
      expect(result).toContain(
        'try{let rerouteResult=await gMe(altPath,n,r,void 0,g,true);if(rerouteResult.info)return rerouteResult}catch{}}}return w===void 0?{info:null,includePaths:[]}:mMe(w,e,n,r)}'
      );
    });

    it('returns the alternative file when the custom reader only knows AGENTS.md', async () => {
      const result = writeAgentsMd(reader, altNames)!;
      const mMe =
        'function mMe(c,e){return{info:{content:c,path:e},includePaths:[]}}';
      const run = new Function(
        `${mMe};const ZB=1;${result.replace('async function gMe', 'globalThis.gMe=async function gMe')};return globalThis.gMe`
      )();
      const g = async (p: string) =>
        p.endsWith('AGENTS.md') ? 'alt body' : undefined;
      const found = await run('/p/CLAUDE.md', 'Project', 'x', undefined, g);
      expect(found.info.path).toBe('/p/AGENTS.md');
      const none = await run(
        '/p/CLAUDE.md',
        'Project',
        'x',
        undefined,
        async () => undefined
      );
      expect(none.info).toBeNull();
    });

    it('threads the extra loader argument through the project walk site', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result).toContain('hn=async(ln,Kn,eo)=>{if(Wt.has(ln)){');
      expect(result).toContain(
        'let found=await XF(altPath,Kn,V,he,0,void 0,void 0,_e,eo);if(found.length)return found'
      );
      expect(result).toContain('return vkt(ln,Kn,V,_e)}');
      expect(result).toContain('return XF(ln,Kn,V,he,0,void 0,void 0,_e,eo)}');
    });

    it('rewrites both walk sites', () => {
      const result = writeAgentsMd(file, altNames)!;
      expect(result.match(/if\(found\.length\)return found/g)).toHaveLength(2);
      expect(result).toContain(
        'let found=await XF(altPath,"User",V,!0,0,void 0,void 0,_e);if(found.length)return found'
      );
    });
  });
});
