// Please see the note about writing patches in ./index

import { showDiff } from './index';

/**
 * Tries alternative memory filenames when CLAUDE.md is missing. Patches the
 * reader and, on newer builds, both project and user memory-walk prechecks.
 *
 * Supports these code patterns across CC versions:
 *
 * CC <=2.1.69 (sync): Function uses readFileSync/existsSync/statSync directly
 * CC >=2.1.83 (async): The reader handles missing files before processing.
 * Newer builds: The walk filters missing paths before they reach the reader.
 */
export const writeAgentsMd = (
  file: string,
  altNames: string[]
): string | null => {
  // CC >= 2.1.87 ships alternative MD file support natively — detect and skip.
  if (/CLAUDE\.md.{0,100}for\(let \w+ of \["AGENTS\.md"/.test(file)) {
    console.log(
      'patch: agentsMd: alternative MD file support already present natively - skipping'
    );
    return file;
  }

  const reader = writeAgentsMdReader(file, altNames);
  if (reader === null) return null;

  // CC >=2.1.278 decides which memory files exist before the reader is
  // called, so the reader's reroute never sees a missing CLAUDE.md there.
  // The walk gets its own reroute; on older versions the sites are absent
  // and the reader's reroute is the whole patch.
  const walk = writeAgentsMdWalkPrecheck(reader, altNames);
  if (walk === false) return null;
  return walk ?? reader;
};

const writeAgentsMdReader = (
  file: string,
  altNames: string[]
): string | null => {
  // Try the storage-backend reader first (CC >=2.1.227)
  const asyncV4 = writeAgentsMdAsyncBackend(file, altNames);
  if (asyncV4) return asyncV4;

  // Try the dir-flag null-check reader next (CC 2.1.210..2.1.226)
  const asyncV3 = writeAgentsMdAsyncDirFlag(file, altNames);
  if (asyncV3) return asyncV3;

  // Try the helper-based null-check reader next (CC 2.1.196..2.1.209)
  const asyncV2 = writeAgentsMdAsyncNullCheck(file, altNames);
  if (asyncV2) return asyncV2;

  // Try the readFile/try-catch async pattern (CC 2.1.83..2.1.195)
  const asyncResult = writeAgentsMdAsync(file, altNames);
  if (asyncResult) return asyncResult;

  // Fall back to the old sync pattern (CC <=2.1.69)
  return writeAgentsMdSync(file, altNames);
};

// CC >=2.1.278: the memory walk lstat-walks every candidate path up front and
// collects the missing ones in a Set (`Ot` below); a path in that Set is
// handed to a marker that records it as processed and returns nothing, and
// the reader is never called for it. Two sites consult the Set:
//   V$t=async(bn,Nn)=>Ot.has(bn)?WRt(bn,Nn,B,_e):k4(bn,Nn,B,he,0,void 0,void 0,_e)
//   Ot.has(Oe)?WRt(Oe,"User",B,_e):await k4(Oe,"User",B,!0,0,void 0,<backend>,_e)
// At each, a missing CLAUDE.md first tries every alternative name through the
// same loader (plain-path read, no backend descriptor: that descriptor carries
// the CLAUDE.md storage key) and falls back to the marker only when none of
// them yields a file. Returns null when neither site is present, which is how
// every earlier version reads.
const writeAgentsMdWalkPrecheck = (
  file: string,
  altNames: string[]
): string | null | false => {
  const altNamesJson = JSON.stringify(altNames);

  const fnSite =
    /(?<![$\w])([$\w]+)=async\(([$\w]+),([$\w]+)(?:,([$\w]+))?\)=>([$\w]+)\.has\(\2\)\?([$\w]+)\(\2,\3,([$\w]+),([$\w]+)\):([$\w]+)\(\2,\3,\7,([$\w]+),0,void 0,void 0,\8(?:,\4)?\)/;
  const userSite =
    /([$\w]+)\.has\(([$\w]+)\)\?([$\w]+)\(\2,"User",([$\w]+),([$\w]+)\):await ([$\w]+)\(\2,"User",\4,!0,0,void 0,([$\w]+!==void 0\?\{backend:[$\w]+,key:[$\w]+\.state\("user-memory"\)\}:void 0),\5\)/;

  const fnMatch = file.match(fnSite);
  const userMatch = file.match(userSite);
  if (!fnMatch || !userMatch) {
    const walkShape = /\.has\([$\w]+\)\?[$\w]+\([$\w]+,"User"/.test(file);
    if (!fnMatch && !userMatch && !walkShape) return null;
    console.error('patch: agentsMd: incomplete memory-walk precheck');
    return false;
  }

  let newFile = file;

  if (fnMatch && fnMatch.index !== undefined) {
    const [
      whole,
      fnName,
      pathP,
      typeP,
      extraP,
      absentSet,
      marker,
      processed,
      exclude,
      loader,
      includeExternal,
    ] = fnMatch;
    const params = extraP ? `${pathP},${typeP},${extraP}` : `${pathP},${typeP}`;
    const tail = extraP ? `,${extraP}` : '';
    const replacement =
      `${fnName}=async(${params})=>{if(${absentSet}.has(${pathP})){` +
      `if(${pathP}.endsWith("/CLAUDE.md")||${pathP}.endsWith("\\\\CLAUDE.md")){` +
      `for(let alt of ${altNamesJson}){let altPath=${pathP}.slice(0,-9)+alt;` +
      `let found=await ${loader}(altPath,${typeP},${processed},${includeExternal},0,void 0,void 0,${exclude}${tail});if(found.length)return found}}` +
      `return ${marker}(${pathP},${typeP},${processed},${exclude})}` +
      `return ${loader}(${pathP},${typeP},${processed},${includeExternal},0,void 0,void 0,${exclude}${tail})}`;
    const start = fnMatch.index;
    newFile =
      newFile.slice(0, start) +
      replacement +
      newFile.slice(start + whole.length);
    showDiff(file, newFile, replacement, start, start + whole.length);
  }

  const userMatch2 = newFile.match(userSite);
  if (userMatch2 && userMatch2.index !== undefined) {
    const [
      whole,
      absentSet,
      pathV,
      marker,
      processed,
      exclude,
      loader,
      backend,
    ] = userMatch2;
    const replacement =
      `${absentSet}.has(${pathV})?await(async()=>{` +
      `for(let alt of ${altNamesJson}){let altPath=${pathV}.slice(0,-9)+alt;` +
      `let found=await ${loader}(altPath,"User",${processed},!0,0,void 0,void 0,${exclude});if(found.length)return found}` +
      `return ${marker}(${pathV},"User",${processed},${exclude})})()` +
      `:await ${loader}(${pathV},"User",${processed},!0,0,void 0,${backend},${exclude})`;
    const start = userMatch2.index;
    const before = newFile;
    newFile =
      newFile.slice(0, start) +
      replacement +
      newFile.slice(start + whole.length);
    showDiff(before, newFile, replacement, start, start + whole.length);
  }

  return newFile;
};

// CC >=2.1.227: the reader gained a 4th param carrying a storage backend, and
// the local read moved into the `else` arm of a backend branch. Shape:
//   async function XPs(e,t,r,n){try{let o,i=!1;
//     if(n){let s=await vd_(n);switch(s.kind){case"absent":return{info:null,…};
//       case"error":…;case"skipped":i=s.isDirectory,o=null;break;
//       case"content":o=s.content;break}}
//     else{let s=gr();o=await XY(s,e,vIo,(a)=>{i=a.isDirectory()})}
//     if(o===null){…skipping…return{info:null,includePaths:[]}}
//     return md_(o,e,t,r)}catch(o){return Td_(o,e),{info:null,includePaths:[]}}}
// CC >=2.1.291 adds a 5th param (a custom reader) and a leading branch
// `if(g){let w=await g(e,L);return w===void 0?{info:null,includePaths:[]}:md_(w,e,t,r)}`
// ahead of the backend branch; it is kept verbatim and the reroute recurses
// with both optional params dropped. A missing file leaves this reader by one of three exits, none of them the
// `o===null` branch: the backend read returns from its own switch, as
// `absent` or as an `error` whose code is ENOENT/ENOTDIR, and the local read
// stats the file before reading it, so its ENOENT is thrown into the catch.
// The reroute is spliced at each of those exits and kept in the `o===null`
// branch for the skipped cases (a directory or an oversize file named
// CLAUDE.md). It recurses with the backend argument dropped (void 0): the
// backend descriptor carries a per-file storage KEY, so reusing it for an
// alternative filename would read the wrong object.
const writeAgentsMdAsyncBackend = (
  file: string,
  altNames: string[]
): string | null => {
  const funcPattern =
    /(async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+),([$\w]+)(?:,([$\w]+))?)\)\{try\{let ([$\w]+),([$\w]+)=!1;((?:if\([$\w]+\)\{let [$\w]+=await [$\w]+\([$\w]+,[$\w]+\);return [$\w]+===void 0\?\{info:null,includePaths:\[\]\}:[$\w]+\([^()]*\)\})?)(if\(\6\)\{[\s\S]*?\}else\{[\s\S]*?\})if\(\8===null\)\{([\s\S]*?\[CLAUDE\.md\] skipping[\s\S]*?return\{info:null,includePaths:\[\]\})\}return ([$\w]+)\(\8,\3,\4,\5\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\14,\3\),\{info:null,includePaths:\[\]\}\}\}/;

  const m = file.match(funcPattern);
  if (!m || m.index === undefined) return null;

  const funcSig = m[1]; // async function XPs(e,t,r,n[,custom]
  const funcName = m[2]; // XPs
  const pathParam = m[3]; // e
  const typeParam = m[4]; // t
  const thirdParam = m[5]; // r
  const customReader = m[7]; // g (CC >=2.1.291 only)
  const contentVar = m[8]; // o
  const dirFlag = m[9]; // i
  const customBranch = m[10]; // if(g){…return w===void 0?…:md_(w,e,t,r)} or ''
  const backendBranch = m[11]; // if(n){…}else{…}
  const nullBody = m[12]; // if(E(`[CLAUDE.md] skipping …`)…return{…}
  const processor = m[13]; // md_
  const catchVar = m[14]; // o (catch-scoped)
  const errorHandler = m[15]; // Td_

  const altNamesJson = JSON.stringify(altNames);

  // This reader reroute also answers the built-in AGENTS.md loader's CLAUDE.md
  // existence probe, suppressing its notice and load event; the walk reroute
  // loads the file on builds that precheck candidate paths.
  // The reroute, as one block: try each alternative name beside the missing
  // CLAUDE.md, reading it through the plain-path branch (no backend handle) so
  // the recursion cannot loop.
  const reroute =
    `if(!didReroute&&(${pathParam}.endsWith("/CLAUDE.md")||${pathParam}.endsWith("\\\\CLAUDE.md"))){` +
    `for(let alt of ${altNamesJson}){let altPath=${pathParam}.slice(0,-9)+alt;` +
    `try{let rerouteResult=await ${funcName}(altPath,${typeParam},${thirdParam},void 0,${customReader ? 'void 0,' : ''}true);if(rerouteResult.info)return rerouteResult}catch{}}}`;

  // A missing file never reaches the null branch below. The backend read
  // returns from its own switch, as `absent` or as an `error` whose code is
  // ENOENT/ENOTDIR, and the plain-path read stats the file first, so its
  // ENOENT is thrown into the catch. Each of those three exits gets the
  // reroute; the null branch keeps its own copy for the skipped cases (a
  // directory or an oversize file named CLAUDE.md).
  const absentReturn = 'case"absent":return{info:null,includePaths:[]}';
  const errorReturn =
    /case"error":return ([$\w]+)\(([$\w]+)\.code,([$\w]+)\),\{info:null,includePaths:\[\]\}/;
  const customBranchWithReroute = customReader
    ? customBranch.replace(
        /^(if\([$\w]+\)\{let ([$\w]+)=await [$\w]+\([^()]*\);)/,
        (head, _all, result) =>
          `${head}if(${result}===void 0&&!didReroute&&(${pathParam}.endsWith("/CLAUDE.md")||${pathParam}.endsWith("\\\\CLAUDE.md"))){` +
          `for(let alt of ${altNamesJson}){let altPath=${pathParam}.slice(0,-9)+alt;` +
          `try{let rerouteResult=await ${funcName}(altPath,${typeParam},${thirdParam},void 0,${customReader},true);if(rerouteResult.info)return rerouteResult}catch{}}}`
      )
    : customBranch;
  const backendBranchWithReroute = backendBranch
    .replace(
      absentReturn,
      `case"absent":{${reroute}return{info:null,includePaths:[]}}`
    )
    .replace(
      errorReturn,
      (_all, handler, result, pathArg) =>
        `case"error":{if(!didReroute&&(${result}.code==="ENOENT"||${result}.code==="ENOTDIR")){${reroute}}` +
        `return ${handler}(${result}.code,${pathArg}),{info:null,includePaths:[]}}`
    );

  const replacement =
    `${funcSig},didReroute){try{let ${contentVar},${dirFlag}=!1;${customBranchWithReroute}${backendBranchWithReroute}` +
    `if(${contentVar}===null){` +
    reroute +
    `${nullBody}}` +
    `return ${processor}(${contentVar},${pathParam},${typeParam},${thirdParam})}catch(${catchVar}){` +
    `if(!didReroute&&${catchVar}&&(${catchVar}.code==="ENOENT"||${catchVar}.code==="ENOTDIR")){${reroute}}` +
    `return ${errorHandler}(${catchVar},${pathParam}),{info:null,includePaths:[]}}}`;

  const startIndex = m.index;
  const endIndex = startIndex + m[0].length;
  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

// CC >=2.1.210: the async reader gained an isDirectory() probe. The reader now
// takes a 4th callback arg that captures whether the path is a directory, and
// the not-found (o===null) branch became a braced compound block that logs the
// skip, records a metric, then returns {info:null,includePaths:[]}. Shape:
//   async function _Kc(e,t,r){try{let n=Jt(),o=!1,
//     i=await Zq(n,e,cKc,(s)=>{o=s.isDirectory()});
//     if(i===null){if(C(`[CLAUDE.md] skipping ${e}: ...`),!pKc&&!o)pKc=!0,We(...);
//       return{info:null,includePaths:[]}}
//     return rrg(i,e,t,r)}catch(n){return org(n,e),{info:null,includePaths:[]}}}
// The AGENTS.md reroute goes at the head of the `i===null` branch, before the
// original skip-log/metric/return body (which we splice back verbatim).
const writeAgentsMdAsyncDirFlag = (
  file: string,
  altNames: string[]
): string | null => {
  const funcPattern =
    /(async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+))\)\{try\{let ([$\w]+)=([$\w]+)\(\),([$\w]+)=!1,([$\w]+)=await ([$\w]+)\(\6,\3,([$\w]+),\(([$\w]+)\)=>\{\8=\12\.isDirectory\(\)\}\);if\(\9===null\)\{([\s\S]*?\[CLAUDE\.md\] skipping[\s\S]*?return\{info:null,includePaths:\[\]\})\}return ([$\w]+)\(\9,\3,\4,\5\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\15,\3\),\{info:null,includePaths:\[\]\}\}\}/;

  const m = file.match(funcPattern);
  if (!m || m.index === undefined) return null;

  const funcSig = m[1]; // async function _Kc(e,t,r
  const funcName = m[2]; // _Kc
  const pathParam = m[3]; // e
  const typeParam = m[4]; // t
  const thirdParam = m[5]; // r
  const ctxVar = m[6]; // n
  const ctxGetter = m[7]; // Jt
  const dirFlag = m[8]; // o
  const contentVar = m[9]; // i
  const reader = m[10]; // Zq
  const limitVar = m[11]; // cKc
  const cbParam = m[12]; // s
  const nullBody = m[13]; // if(C(`[CLAUDE.md] skipping ...`)...return{info:null,includePaths:[]}
  const processor = m[14]; // rrg
  const catchVar = m[15]; // n (catch-scoped)
  const errorHandler = m[16]; // org

  const altNamesJson = JSON.stringify(altNames);

  // `rerouteResult` (not `${ctxVar}`) — the try block already declares it.
  const replacement =
    `${funcSig},didReroute){try{let ${ctxVar}=${ctxGetter}(),${dirFlag}=!1,${contentVar}=await ${reader}(${ctxVar},${pathParam},${limitVar},(${cbParam})=>{${dirFlag}=${cbParam}.isDirectory()});` +
    `if(${contentVar}===null){` +
    `if(!didReroute&&(${pathParam}.endsWith("/CLAUDE.md")||${pathParam}.endsWith("\\\\CLAUDE.md"))){` +
    `for(let alt of ${altNamesJson}){let altPath=${pathParam}.slice(0,-9)+alt;` +
    `try{let rerouteResult=await ${funcName}(altPath,${typeParam},${thirdParam},true);if(rerouteResult.info)return rerouteResult}catch{}}}` +
    `${nullBody}}` +
    `return ${processor}(${contentVar},${pathParam},${typeParam},${thirdParam})}catch(${catchVar}){return ${errorHandler}(${catchVar},${pathParam}),{info:null,includePaths:[]}}}`;

  const startIndex = m.index;
  const endIndex = startIndex + m[0].length;
  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

// CC >=2.1.196: the async reader was refactored to a helper that returns null
// on failure instead of throwing. Shape:
//   async function Uca(e,t,n){try{let r=Vt(),o=await qN(r,e,Gao);
//     if(o===null)return C(`[CLAUDE.md] skipping ${e}: ...`),{info:null,includePaths:[]};
//     return mpp(o,e,t,n)}catch(r){return hpp(r,e),{info:null,includePaths:[]}}}
// The not-found path is now the `o===null` branch (not the catch), so the
// AGENTS.md reroute goes there.
const writeAgentsMdAsyncNullCheck = (
  file: string,
  altNames: string[]
): string | null => {
  const funcPattern =
    /(async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+))\)\{try\{let ([$\w]+)=([$\w]+)\(\),([$\w]+)=await ([$\w]+)\(\6,\3,([$\w]+)\);if\(\8===null\)return (([$\w]+)\(`\[CLAUDE\.md\] skipping[^`]*`\),\{info:null,includePaths:\[\]\});return ([$\w]+)\(\8,\3,\4,\5\)\}catch\(([$\w]+)\)\{return (([$\w]+)\(\14,\3\),\{info:null,includePaths:\[\]\})\}\}/;

  const m = file.match(funcPattern);
  if (!m || m.index === undefined) return null;

  const funcSig = m[1]; // async function NAME(P1,P2,P3
  const funcName = m[2]; // Uca
  const pathParam = m[3]; // e
  const typeParam = m[4]; // t
  const thirdParam = m[5]; // n
  const ctxVar = m[6]; // r
  const ctxGetter = m[7]; // Vt
  const contentVar = m[8]; // o
  const reader = m[9]; // qN
  const limitVar = m[10]; // Gao
  const skipReturn = m[11]; // C(`[CLAUDE.md] skipping ...`),{info:null,includePaths:[]}
  const processor = m[13]; // mpp
  const catchVar = m[14]; // r (catch-scoped)
  const catchReturn = m[15]; // hpp(r,e),{info:null,includePaths:[]}

  const altNamesJson = JSON.stringify(altNames);

  // `rerouteResult` (not `r`) — the try block already declares `${ctxVar}` (r).
  const replacement =
    `${funcSig},didReroute){try{let ${ctxVar}=${ctxGetter}(),${contentVar}=await ${reader}(${ctxVar},${pathParam},${limitVar});` +
    `if(${contentVar}===null){` +
    `if(!didReroute&&(${pathParam}.endsWith("/CLAUDE.md")||${pathParam}.endsWith("\\\\CLAUDE.md"))){` +
    `for(let alt of ${altNamesJson}){let altPath=${pathParam}.slice(0,-9)+alt;` +
    `try{let rerouteResult=await ${funcName}(altPath,${typeParam},${thirdParam},true);if(rerouteResult.info)return rerouteResult}catch{}}}` +
    `return ${skipReturn};}` +
    `return ${processor}(${contentVar},${pathParam},${typeParam},${thirdParam})}catch(${catchVar}){return ${catchReturn}}}`;

  const startIndex = m.index;
  const endIndex = startIndex + m[0].length;
  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

const writeAgentsMdAsync = (
  file: string,
  altNames: string[]
): string | null => {
  // Match the async reader function that:
  // 1. Contains readFile (async)
  // 2. Has a catch block that calls a function with error code checks (ENOENT/EISDIR)
  // 3. Returns {info:null,includePaths:[]}
  const funcPattern =
    /(async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+))\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\3,\{encoding:"utf-8"\}\);return ([$\w]+)\(\6,\3,\4,\5\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\9,\3\),\{info:null,includePaths:\[\]\}\}\}/;

  const funcMatch = file.match(funcPattern);
  if (!funcMatch || funcMatch.index === undefined) {
    return null;
  }

  const fullMatch = funcMatch[0];
  const funcSig = funcMatch[1]; // async function NAME(A,q,K
  const funcName = funcMatch[2]; // jh1
  const pathParam = funcMatch[3]; // A
  const typeParam = funcMatch[4]; // q
  const thirdParam = funcMatch[5]; // K
  const readVar = funcMatch[6]; // z
  const fsGetter = funcMatch[7]; // j8
  const processorFunc = funcMatch[8]; // XB9
  const catchVar = funcMatch[9]; // _
  const errorHandler = funcMatch[10]; // DB9

  const altNamesJson = JSON.stringify(altNames);

  const replacement =
    `${funcSig},didReroute){try{let ${readVar}=await ${fsGetter}().readFile(${pathParam},{encoding:"utf-8"});return ${processorFunc}(${readVar},${pathParam},${typeParam},${thirdParam})}catch(${catchVar}){` +
    `if(!didReroute&&(${pathParam}.endsWith("/CLAUDE.md")||${pathParam}.endsWith("\\\\CLAUDE.md"))){` +
    `for(let alt of ${altNamesJson}){` +
    `let altPath=${pathParam}.slice(0,-9)+alt;` +
    `try{let r=await ${funcName}(altPath,${typeParam},${thirdParam},true);if(r.info)return r}catch{}` +
    `}}` +
    `return ${errorHandler}(${catchVar},${pathParam}),{info:null,includePaths:[]}}}`;

  const startIndex = funcMatch.index;
  const endIndex = startIndex + fullMatch.length;

  const newFile =
    file.slice(0, startIndex) + replacement + file.slice(endIndex);

  showDiff(file, newFile, replacement, startIndex, endIndex);

  return newFile;
};

const writeAgentsMdSync = (file: string, altNames: string[]): string | null => {
  const funcPattern =
    /(function ([$\w]+)\(([$\w]+),([^)]+?))\)(?:.|\n){0,500}Skipping non-text file in @include/;

  const funcMatch = file.match(funcPattern);
  if (!funcMatch || funcMatch.index === undefined) {
    console.error('patch: agentsMd: failed to find CLAUDE.md reading function');
    return null;
  }
  const upToFuncParamsClosingParen = funcMatch[1];
  const functionName = funcMatch[2];
  const firstParam = funcMatch[3];
  const restParams = funcMatch[4];
  const funcStart = funcMatch.index;

  const fsPattern = /([$\w]+(?:\(\))?)\.(?:readFileSync|existsSync|statSync)/;
  const fsMatch = funcMatch[0].match(fsPattern);
  let callerFsMatch: RegExpMatchArray | null = null;
  if (!fsMatch) {
    // Try the caller function for fs expression
    const callerSearch = file.slice(Math.max(0, funcStart - 5000), funcStart);
    callerFsMatch = callerSearch.match(fsPattern);
    if (!callerFsMatch) {
      console.error(
        'patch: agentsMd: failed to find fs expression in function or caller'
      );
      return null;
    }
  }

  const fsExpr = fsMatch
    ? fsMatch[1]
    : callerFsMatch
      ? callerFsMatch[1]
      : 'require("fs")';

  const altNamesJson = JSON.stringify(altNames);

  const sigIndex = funcStart + upToFuncParamsClosingParen.length;
  let newFile = file.slice(0, sigIndex) + ',didReroute' + file.slice(sigIndex);

  showDiff(file, newFile, ',didReroute', sigIndex, sigIndex);

  const funcBody = newFile.slice(funcStart);

  const oldEarlyReturnPattern = /\.isFile\(\)\)return null/;
  const newEarlyReturnPattern = /==="EISDIR"\)return null/;

  const earlyReturnMatch =
    funcBody.match(oldEarlyReturnPattern) ??
    funcBody.match(newEarlyReturnPattern);

  if (!earlyReturnMatch || earlyReturnMatch.index === undefined) {
    console.error(
      'patch: agentsMd: failed to find early return null for injection'
    );
    return null;
  }

  const isNewPattern = !funcBody.match(oldEarlyReturnPattern);

  const fallback = `if(!didReroute&&(${firstParam}.endsWith("/CLAUDE.md")||${firstParam}.endsWith("\\\\CLAUDE.md"))){for(let alt of ${altNamesJson}){let altPath=${firstParam}.slice(0,-9)+alt;if(${fsExpr}.existsSync(altPath)&&${fsExpr}.statSync(altPath).isFile())return ${functionName}(altPath,${restParams},true);}}`;

  const earlyReturnStart = funcStart + earlyReturnMatch.index;
  const oldStr = earlyReturnMatch[0];
  const newStr = isNewPattern
    ? `==="EISDIR"){${fallback}return null;}`
    : `.isFile()){${fallback}return null;}`;

  newFile =
    newFile.slice(0, earlyReturnStart) +
    newStr +
    newFile.slice(earlyReturnStart + oldStr.length);

  showDiff(file, newFile, newStr, earlyReturnStart, earlyReturnStart);

  return newFile;
};
