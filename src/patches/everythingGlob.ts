// Please see the note about writing patches in ./index

import { escapeNonAscii } from '../utils';
import { showDiff } from './index';

// Runs inside CC (Bun). Mirrors what rg does with CC's Glob args: globs are
// gitignore-style and anchored at opts.cwd (rg's working folder, CC's
// spawnCwd), not at the search target. CC rewrites anchored patterns with
// that in mind, so matching against target-relative paths would make
// anchored deny rules silently miss. Anything we don't mirror goes to rg.
export const buildEverythingGlobRuntime = (esPath: string): string => {
  const es = escapeNonAscii(JSON.stringify(esPath));
  return String.raw`(async(rg,state,args,target,signal,opts)=>{
let fallback=()=>rg(args,target,signal,opts);
if(typeof Bun==="undefined")return fallback();
let known=["--files","--null","--sort=modified","--no-ignore","--hidden"],flags=new Set,globs=[];
for(let i=0;i<args.length;i++){let a=args[i];
if(a==="--glob"||a==="--iglob"){globs.push({glob:args[++i],ci:a==="--iglob"});continue}
if(!known.includes(a))return fallback();flags.add(a)}
if(!flags.has("--no-ignore")||!flags.has("--hidden"))return fallback();
let rules=globs.map(({glob,ci})=>{let negative=glob.startsWith("!"),body=negative?glob.slice(1):glob,dirOnly=body.endsWith("/");
if(dirOnly)body=body.slice(0,-1);body=body.includes("/")?body.replace(/^\//,""):"**/"+body;
return{negative,dirOnly,ci,glob:new Bun.Glob(ci?body.toLowerCase():body)}});
let hasPositive=rules.some(r=>!r.negative),lastHit=(p,isDir)=>{let hit=null;for(let r of rules){if(r.dirOnly&&!isDir)continue;if(r.glob.match(r.ci?p.toLowerCase():p))hit=r}return hit};
let[{execFile},fs,os,path]=await Promise.all([import("node:child_process"),import("node:fs/promises"),import("node:os"),import("node:path")]);
let cwd=opts.cwd,targetRel=path.relative(cwd,target);
if(targetRel.startsWith("..")||path.isAbsolute(targetRel))return fallback();
opts.beforeSpawn();
let prefix=target.endsWith("\\")?target:target+"\\",main=globs[0].glob,name=main.split("/").pop(),query=["-path",prefix,"/a-d","-sort","date-modified-ascending"];
if(!main.startsWith("!")&&!name.includes("**")&&/^[\w.*?-]+$/.test(name))query.push("wfn:"+name);
let tmp=path.join(os.tmpdir(),"tweakcc-es-"+crypto.randomUUID()+".txt"),text;
try{let ok=await new Promise(done=>execFile(${es},[...query,"-export-txt",tmp],{signal,windowsHide:true},e=>done(!e)));
if(!ok)return fallback();text=await fs.readFile(tmp,"utf8")}finally{await fs.rm(tmp,{force:true})}
let lower=prefix.toLowerCase(),files=text.split(/\r?\n/).filter(l=>l.length>prefix.length&&l.slice(0,prefix.length).toLowerCase()===lower).map(l=>prefix+l.slice(prefix.length));
if(files.length===0)return fallback();
let skip=targetRel===""?0:targetRel.split(path.sep).length;
let kept=files.filter(f=>{let parts=path.relative(cwd,f).split(path.sep);
for(let k=skip+1;k<parts.length;k++){if(lastHit(parts.slice(0,k).join("/"),!0)?.negative)return!1}
let hit=lastHit(parts.join("/"),!1);return hit?!hit.negative:!hasPositive});
state.judgeEveryResult=!0;return kept})`;
};

export const writeEverythingGlob = (
  oldFile: string,
  esPath: string
): string | null => {
  if (oldFile.includes('globalThis.__tweakccEverythingGlob??=')) return oldFile;
  // CC 2.1.323: `wt=await hJ(Ee,e.target,h,{rawLines:!0,rejectOnInputError:!0,searchOtherAppsData:!0,cwd:e.spawnCwd,...`
  const pattern =
    /=await ([$\w]+)\(([$\w]+),([$\w]+)\.target,([$\w]+),\{rawLines:!0,rejectOnInputError:!0,searchOtherAppsData:!0,/g;
  const matches = [...oldFile.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      `patch: everythingGlob: expected one Glob ripgrep call, found ${matches.length}`
    );
    return null;
  }
  const [original, rg, args, state, signal] = matches[0];
  const start = matches[0].index;
  const end = start + original.length;
  const replacement =
    `=await (globalThis.__tweakccEverythingGlob??=${buildEverythingGlobRuntime(esPath)})` +
    `(${rg},${state},${args},${state}.target,${signal},{rawLines:!0,rejectOnInputError:!0,searchOtherAppsData:!0,`;
  const updated = oldFile.slice(0, start) + replacement + oldFile.slice(end);
  showDiff(oldFile, updated, replacement, start, end);
  return updated;
};
