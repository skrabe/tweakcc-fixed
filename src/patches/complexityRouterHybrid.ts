import {
  JEV_EFFORT_INSTRUCTIONS,
  ROUTER_SUMMARY_INSTRUCTIONS,
} from '../routerEffortGuidance';
import { ComplexityRouterConfig } from '../types';
import { escapeNonAscii } from '../utils';
import { buildRouterCredentialRuntime } from '../routerCredentials';

export const buildHybridRuntime = (
  config: ComplexityRouterConfig,
  helpers: { gB: string; km: string },
  sidFn: string | null,
  requireFunc: string
): string => {
  const settings = {
    levels: config.levels,
    model: config.jevModel || 'jev-1.13.0',
    timeout: config.jevTimeoutMs || 2000,
    summaryTimeout: config.timeoutMs || 15000,
    budget: Math.min(config.contextBudgetBytes || 24000, 28000),
    summaryCap: config.summaryMaxChars || 6000,
  };
  return escapeNonAscii(
    buildRouterCredentialRuntime(requireFunc) +
      String.raw`
var __tweakccRouterSettings=${JSON.stringify(settings)};
function __tweakccRouterSid(){var valid=function(id){return typeof id==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(id)};var hint=globalThis.__tweakccRouterSessionId;if(valid(hint))return hint;try{var id=${sidFn ? `${sidFn}()` : 'null'};return valid(id)?id:null}catch(e){return null}}
function __tweakccRouterState(){
  var sid=__tweakccRouterSid(),s=globalThis.__tweakccRouter;
  if(!s||s.sid!==sid){if(s){s.generation++;if(s.summaryAbort)s.summaryAbort.abort();if(s.routeAbort)s.routeAbort.abort()}
    s=globalThis.__tweakccRouter={sid:sid,level:void 0,effort:void 0,baseline:void 0,summary:"",events:[],serial:0,generation:0,turn:0,log:[],loaded:false,seen:[]};}
  return s;
}
function __tweakccRouterSyncSelection(){
  var s=__tweakccRouterState(),selected=null;try{selected=typeof globalThis.__tweakccRouterSelectedModel==="function"?globalThis.__tweakccRouterSelectedModel():null}catch(e){}
  if(typeof selected!=="string"||!selected)selected=null;
  if(s.selectedModel!==selected){
    if(s.selectedModel!==void 0){s.generation++;s.turn++}
    if(s.summaryAbort)s.summaryAbort.abort();if(s.routeAbort)s.routeAbort.abort();
    s.summaryBusy=false;s.summaryAbort=null;s.routeAbort=null;s.level=void 0;s.effort=void 0;s.baseline=void 0;s.decision=void 0;s.selectedModel=selected;
  }
  return selected;
}
function __tweakccRouterTrunc(text,cap){
  if(typeof text!=="string")return "";if(text.length<=cap)return text;
  var marker="\n[content omitted]\n",room=Math.max(0,cap-marker.length),half=Math.floor(room/2);
  return text.slice(0,half)+marker+text.slice(text.length-(room-half));
}
function __tweakccRouterBytes(value){return Buffer.byteLength(JSON.stringify(value),"utf8")}
function __tweakccRouterEvent(s,role,text){
  if(typeof text!=="string"||!text.trim())return;
  var event={id:++s.serial,role:role,text:__tweakccRouterTrunc(text,8000)};
  while(__tweakccRouterBytes(event)>8000)event.text=__tweakccRouterTrunc(event.text,Math.floor(event.text.length/2));
  s.events.push(event);
  if(event.text!==text||(text.includes("[non-text content unavailable to router]")||text.includes("[content omitted]"))){s.contextOmitted=true;s.omissionSerial=s.serial;}
  while(s.events.length>32||__tweakccRouterBytes(s.events)>16000){s.events.shift();s.contextOmitted=true;s.omissionSerial=s.serial;}
}
function __tweakccRouterFile(s){return ${requireFunc}("path").join(${requireFunc}("os").homedir(),".tweakcc","router-state",s.sid+".json")}
function __tweakccRouterLoad(s){
  if(s.loaded)return;s.loaded=true;if(!s.sid)return;
  try{var fs=${requireFunc}("fs"),file=__tweakccRouterFile(s),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16777216||Date.now()-stat.mtimeMs>1209600000)return;
    var data=JSON.parse(fs.readFileSync(file,"utf8"));if(data.version!==2)return;
    s.summary=__tweakccRouterTrunc(data.summary,__tweakccRouterSettings.summaryCap);
    s.compactionSource=__tweakccRouterCompactionCopy(data.compactionSource);
    if(data.model===s.selectedModel&&s.selectedModel&&Number.isInteger(data.level)&&data.level>=0&&data.level<__tweakccRouterSettings.levels.length){s.level=data.level;s.effort=__tweakccRouterSettings.levels[data.level].effort}
    if(Array.isArray(data.events))for(var event of data.events.slice(-32))if(event&&typeof event.text==="string")__tweakccRouterEvent(s,event.role==="assistant"?"assistant":"user",event.text);
    if(Array.isArray(data.seen))s.seen=data.seen.filter(function(x){return typeof x==="string"}).slice(-128);
    s.contextOmitted=!!data.contextOmitted||!!data.compactionSourceNotPersisted;if(typeof data.compactId==="string")s.compactId=data.compactionSourceNotPersisted?void 0:data.compactId;
    if(Array.isArray(data.log))s.log=data.log.filter(function(x){return x&&typeof x.ts==="number"&&typeof x.summary==="string"}).slice(-24);
  }catch(e){}
}
function __tweakccRouterSave(s){
  if(!s.sid)return;
  try{var fs=${requireFunc}("fs").promises,path=${requireFunc}("path"),file=__tweakccRouterFile(s),dir=path.dirname(file);
    var snapshots=s.log.slice(-24);while(__tweakccRouterBytes(snapshots)>350000)snapshots.shift();
    var compact=s.compactionSource,storedCompact=compact&&__tweakccRouterBytes(compact)<=8000000?compact:void 0;
    var data=JSON.stringify({version:2,compactionSource:storedCompact,compactionSourceNotPersisted:!!compact&&!storedCompact,model:s.selectedModel,summary:s.summary,level:s.level,events:s.events,seen:s.seen,compactId:s.compactId,contextOmitted:s.contextOmitted,log:snapshots,decision:s.decision,updatedAt:Date.now()});
    var queues=globalThis.__tweakccRouterWrites||(globalThis.__tweakccRouterWrites=new Map());
    var previous=queues.get(file)||Promise.resolve();
    var write=previous.catch(function(){}).then(async function(){
      await fs.mkdir(dir,{recursive:true,mode:448});var stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())return;
      if(!globalThis.__tweakccRouterPruned){globalThis.__tweakccRouterPruned=true;try{for(var name of await fs.readdir(dir)){if(!/^[a-zA-Z0-9_-]{1,128}\.json$/.test(name))continue;var old=path.join(dir,name),info=await fs.lstat(old);if(info.isFile()&&!info.isSymbolicLink()&&Date.now()-info.mtimeMs>1209600000)await fs.unlink(old)}}catch(e){}}
      var temp=file+"."+process.pid+"."+${requireFunc}("crypto").randomBytes(8).toString("hex")+".tmp";
      try{await fs.writeFile(temp,data,{encoding:"utf8",mode:384,flag:"wx"});await fs.rename(temp,file)}finally{await fs.unlink(temp).catch(function(){})}
    }).catch(function(){});
    queues.set(file,write);write.finally(function(){if(queues.get(file)===write)queues.delete(file)});
  }catch(e){}
}
function __tweakccRouterInvalidate(s){
  s.generation++;s.turn++;if(s.summaryAbort)s.summaryAbort.abort();if(s.routeAbort)s.routeAbort.abort();
  s.summaryBusy=false;s.summaryAbort=null;s.routeAbort=null;s.events=[];s.seen=[];s.prevAssistant=void 0;s.contextOmitted=false;s.submittedText=void 0;s.decision=void 0;s.compactionSource=void 0;
}
function __tweakccRouterReset(s){
  __tweakccRouterInvalidate(s);s.summary="";s.compactId=void 0;s.level=void 0;s.effort=void 0;s.baseline=void 0;s.log=[];s.pendingCompaction=void 0;s.pendingRewindCut=void 0;s.loaded=true;__tweakccRouterSave(s);
}
function __tweakccRouterObserve(messages,sidHint,stamp){if(!__tweakccRouterSyncSelection())return;var s=__tweakccRouterState();if(typeof sidHint==="string"&&sidHint!==s.sid)return;if(stamp&&(stamp.sid!==s.sid||stamp.generation!==s.generation||stamp.turn!==s.turn))return;if(s.pendingCompaction!=null||s.pendingRewindCut!=null)return;__tweakccRouterLoad(s);__tweakccRouterTranscript(s,messages);__tweakccRouterSave(s);__tweakccRouterSummarize(s)}
function __tweakccRouterCapture(text){
  if(!__tweakccRouterSyncSelection())return;var s=__tweakccRouterState();__tweakccRouterLoad(s);__tweakccRouterEvent(s,"assistant",text);__tweakccRouterSave(s);__tweakccRouterSummarize(s);
}
function __tweakccRouterTextData(value){
  var visited=0;
  function clean(item,depth){
    if(++visited>256||depth>8)return "[content omitted]";
    if(typeof item==="string")return __tweakccRouterTrunc(item,8000);
    if(item===null||typeof item==="number"||typeof item==="boolean")return item;
    if(Array.isArray(item)){var list=item.slice(0,64).map(function(child){return clean(child,depth+1)});if(item.length>64)list.push("[content omitted]");return list}
    if(!item||typeof item!=="object")return null;
    if(["image","image_url","input_image","document","audio","input_audio","base64"].includes(item.type)||item.encoding==="base64")return "[non-text content unavailable to router]";
    var media=item.mimeType||item.mime_type||item.media_type;if(typeof media==="string"&&/^(image\/|audio\/|video\/|application\/pdf)/i.test(media))return "[non-text content unavailable to router]";
    var result=Object.create(null),keys=Object.keys(item);
    for(var key of keys.slice(0,64)){if(/base64|image_data|audio_data|^blob$/i.test(key))result[key]="[non-text content unavailable to router]";else result[key]=clean(item[key],depth+1)}
    if(keys.length>64)result.__omitted="[content omitted]";
    return result;
  }
  return clean(value,0);
}
function __tweakccRouterTranscript(s,messages){
  if(!Array.isArray(messages))return;
  if(!s.seen.length&&messages.length>128){s.contextOmitted=true;s.omissionSerial=s.serial+1;}
  var fresh=[];
  for(var message of messages.slice(-128)){
    if(!message||!message.uuid||s.seen.includes(message.uuid))continue;
    s.seen.push(message.uuid);var role=message.type;
    if((role!=="assistant"&&role!=="user")||message.isCompactSummary===true)continue;
    var content=message.message&&message.message.content;
    var parts=typeof content==="string"?[content]:Array.isArray(content)?content.map(function(block){
      if(block.type==="text")return block.text;
      if(block.type==="tool_use")return "Tool "+block.name+": "+JSON.stringify(__tweakccRouterTextData(block.input));
      if(block.type==="tool_result")return "Tool result: "+JSON.stringify(__tweakccRouterTextData(block.content));
      if(["image","image_url","input_image","document","audio","input_audio"].includes(block.type))return "[non-text content unavailable to router]";
      return "";
    }):[];
    var text=parts.filter(function(x){return typeof x==="string"}).join("\n");
    if(role==="user"&&text===s.submittedText){s.submittedText=void 0;continue}
    if(text)fresh.push({role:role,text:text});
  }
  s.seen=s.seen.slice(-128);
  for(var event of fresh)__tweakccRouterEvent(s,event.role,event.text);
}
function __tweakccRouterCommittedContext(s,messages){
  if(!Array.isArray(messages))return messages;
  var boundary=-1,summary=-1;
  for(var index=0;index<messages.length;index++){
    var message=messages[index];if(!message)continue;
    if(message.type==="system"&&message.subtype==="compact_boundary"){boundary=index;summary=-1}
    if(message.type==="user"&&message.isCompactSummary===true)summary=index;
  }
  var marker=messages[summary>=0?summary:boundary];if(!marker||typeof marker.uuid!=="string")return messages;
  if(marker.uuid===s.compactId)return boundary>=0?messages.slice(boundary):messages;
  var content=summary>=0&&marker.message&&marker.message.content;
  var text=typeof content==="string"?content:Array.isArray(content)?content.filter(function(block){return block.type==="text"&&typeof block.text==="string"}).map(function(block){return block.text}).join("\n"):"";
  if(!(s.compactionSource&&(s.compactionSource.text===text||!text&&s.capturedCompaction)))__tweakccRouterStageCompaction(s,text);
  s.log=[];s.compactId=marker.uuid;s.seen=[marker.uuid];
  __tweakccRouterSave(s);
  return boundary>=0?messages.slice(boundary):messages;
}
function __tweakccRouterCompactionCopy(pending){return pending&&typeof pending.text==="string"&&Number.isInteger(pending.offset)&&pending.offset>=0&&pending.offset<pending.text.length&&typeof pending.summary==="string"&&pending.summary.length<=__tweakccRouterSettings.summaryCap?{text:pending.text,offset:pending.offset,summary:pending.summary}:void 0}
function __tweakccRouterStageCompaction(s,text){
  __tweakccRouterInvalidate(s);s.log=[];if(!text){s.contextOmitted=true;s.omissionSerial=s.serial+1;}
  if(typeof text==="string"&&text)s.compactionSource={text:text,offset:0,summary:""};
}
function __tweakccRouterReadSummary(result){
  if(result&&typeof result.summary==="string")return result.summary;
  var content=result&&((result.message&&result.message.content)||result.content);
  var text=typeof result==="string"?result:Array.isArray(content)?content.filter(function(b){return b.type==="text"}).map(function(b){return b.text}).join(""):result&&result.text;
  try{var parsed=JSON.parse(text);return typeof parsed.summary==="string"?parsed.summary:null}catch(e){return null}
}
async function __tweakccRouterDeadline(work,controller,timeout){
  var timer,onAbort;try{return await Promise.race([Promise.resolve().then(function(){if(controller.signal.aborted)throw Error("router aborted");return work()}),new Promise(function(resolve,reject){onAbort=function(){reject(Error("router aborted"))};controller.signal.addEventListener("abort",onAbort,{once:true});if(controller.signal.aborted)onAbort();timer=setTimeout(function(){controller.abort();reject(Error("router timeout"))},timeout)})])}finally{clearTimeout(timer);if(onAbort)controller.signal.removeEventListener("abort",onAbort)}
}
function __tweakccRouterSummarize(s){
  var selected=__tweakccRouterSyncSelection();if(!selected||s!==globalThis.__tweakccRouter||s.summaryBusy||!s.events.length&&!s.compactionSource)return;
  s.summaryBusy=true;var generation=s.generation,through=s.serial,controller=new AbortController();s.summaryAbort=controller;
  var compact=s.compactionSource,offset=compact?compact.offset:0,end=compact?Math.min(compact.text.length,offset+12000):0,accepted=false;
  if(compact&&end<compact.text.length&&compact.text.charCodeAt(end-1)>=55296&&compact.text.charCodeAt(end-1)<=56319)end--;
  var input=JSON.stringify(compact?{previousSummary:compact.summary,compactionDocument:compact.text.slice(offset,end),compactionPart:{offset:offset,end:end,total:compact.text.length},events:[],contextOmitted:false}:{previousSummary:s.summary,events:s.events,contextOmitted:!!s.contextOmitted});
  var schema={type:"object",properties:{summary:{type:"string"}},required:["summary"],additionalProperties:false};
  __tweakccRouterDeadline(function(){if(__tweakccRouterSyncSelection()!==selected||s.generation!==generation)throw Error("router inactive");return ${helpers.gB}({
    systemPrompt:[${JSON.stringify(ROUTER_SUMMARY_INSTRUCTIONS)}+(compact?" Condense the native compaction document semantically. Each part is contiguous source text; integrate it with the previous partial digest, preserving relevant facts throughout. Do not treat a part boundary as omitted source.":"")+" Keep under "+__tweakccRouterSettings.summaryCap+" characters; prefer much shorter when sufficient."],
    userPrompt:input,outputFormat:{type:"json_schema",schema:schema},signal:controller.signal,
    options:{querySource:"route_complexity",agents:[],isNonInteractiveSession:false,hasAppendSystemPrompt:false,mcpTools:[],agentContext:${helpers.km}()}
  })},controller,__tweakccRouterSettings.summaryTimeout).then(function(result){
    if(__tweakccRouterSyncSelection()!==selected||s!==globalThis.__tweakccRouter||s.generation!==generation)return;
    var summary=__tweakccRouterReadSummary(result);if(!summary||summary.length>__tweakccRouterSettings.summaryCap)return;
    accepted=true;
    if(compact){if(s.compactionSource!==compact)return;compact.offset=end;compact.summary=summary;if(end===compact.text.length){s.summary=summary;s.compactionSource=void 0;}}
    else{s.summary=summary;s.events=s.events.filter(function(event){return event.id>through});s.contextOmitted=s.omissionSerial>through;}
    __tweakccRouterSave(s);
  }).catch(function(){}).finally(function(){
    if(__tweakccRouterSyncSelection()!==selected||s!==globalThis.__tweakccRouter||s.generation!==generation)return;s.summaryBusy=false;s.summaryAbort=null;
    if(compact?accepted||s.serial>through:s.serial>through)__tweakccRouterSummarize(s);
  });
}
function __tweakccRouterBody(s,text,model){
  var settings=__tweakccRouterSettings,criteria={};if(settings.levels.length>255)return null;settings.levels.forEach(function(level,index){criteria[String(index)]=level.effort+": "+level.help});
  var body={model:settings.model,state:{currentMessage:text,summary:s.summary,recentEvents:s.events.map(function(event){return {role:event.role,text:event.text}}),contextOmitted:!!s.contextOmitted||!!s.compactionSource,model:typeof model==="string"?model:"unknown",currentMessageOmitted:text.includes("[content omitted]")||text.includes("[non-text content unavailable to router]")},questions:{effort:{type:"choice",instructions:${JSON.stringify(JEV_EFFORT_INSTRUCTIONS)},criteria:criteria}}};
  while(__tweakccRouterBytes(body)>settings.budget){
    body.state.contextOmitted=true;
    var events=body.state.recentEvents;
    if(events.length){events.shift();continue}
    if(body.state.summary.length>256){body.state.summary=__tweakccRouterTrunc(body.state.summary,Math.floor(body.state.summary.length/2));continue}
    if(body.state.currentMessage.length>256){body.state.currentMessageOmitted=true;body.state.currentMessage=__tweakccRouterTrunc(body.state.currentMessage,Math.floor(body.state.currentMessage.length/2));continue}
    return null;
  }
  return body;
}
function __tweakccRouterDecision(result){
  var answer=result&&result.answers&&result.answers.effort,levels=__tweakccRouterSettings.levels;
  if(!answer||answer.type!=="choice"||typeof answer.choice!=="string"||!/^\d+$/.test(answer.choice))return null;
  var level=Number(answer.choice),probabilities=answer.probabilities;
  if(String(level)!==answer.choice||level>=levels.length||!probabilities||typeof probabilities!=="object")return null;
  var total=0;
  for(var index=0;index<levels.length;index++){var p=probabilities[String(index)];if(typeof p!=="number"||!Number.isFinite(p)||p<0||p>1)return null;if(p>probabilities[answer.choice]+0.000001)return null;total+=p}
  if(Object.keys(probabilities).length!==levels.length||Math.abs(total-1)>0.02)return null;
  if(typeof answer.confidence!=="number"||!Number.isFinite(answer.confidence)||answer.confidence<0||answer.confidence>1)return null;
  return {level:level,confidence:answer.confidence};
}
async function __tweakccRouterClassify(text,mode,model,messages,sidHint){
  if(typeof sidHint==="string"&&/^[a-zA-Z0-9_-]{1,128}$/.test(sidHint))globalThis.__tweakccRouterSessionId=sidHint;
  var selected=__tweakccRouterSyncSelection();if(typeof text!=="string")return;var s=__tweakccRouterState(),trimmed=text.trimStart();
  if(/^\/clear(\s|$)/.test(trimmed)){__tweakccRouterReset(s);return}
  if(!selected)return;
  if(trimmed.startsWith("/")||(mode!==void 0&&mode!=="prompt"))return;
  __tweakccRouterLoad(s);
  if(s.pendingRewindCut!=null){var cut=typeof s.pendingRewindCut==="number"?s.pendingRewindCut:Date.parse(s.pendingRewindCut),snapshot=s.log.filter(function(item){return item.ts<=cut}).at(-1);__tweakccRouterInvalidate(s);s.summary=snapshot?snapshot.summary:"";s.compactionSource=__tweakccRouterCompactionCopy(snapshot&&snapshot.compactionSource);s.level=snapshot?snapshot.level:void 0;s.effort=Number.isInteger(s.level)?__tweakccRouterSettings.levels[s.level]?.effort:void 0;s.log=s.log.filter(function(item){return item.ts<cut});s.pendingRewindCut=void 0;s.pendingCompaction=void 0;}
  if(typeof s.pendingCompaction==="string"){var compact=s.pendingCompaction;__tweakccRouterStageCompaction(s,compact);s.capturedCompaction=true;s.pendingCompaction=void 0;}
  __tweakccRouterTranscript(s,__tweakccRouterCommittedContext(s,messages));s.capturedCompaction=void 0;
  var settings=__tweakccRouterSettings,levels=settings.levels;if(!levels.length)return;
  s.log.push({ts:Date.now(),summary:s.summary,level:s.level,compactionSource:s.compactionSource?{...s.compactionSource}:void 0});s.log=s.log.slice(-24);
  var generation=s.generation,turn=++s.turn,controller=new AbortController();if(s.routeAbort)s.routeAbort.abort();s.routeAbort=controller;
  var body=__tweakccRouterBody(s,text,selected),decision=null,failure=body?"request-failed":"request-too-large";s.decision=void 0;
  __tweakccRouterEvent(s,"user",text);s.submittedText=text;__tweakccRouterSummarize(s);
  if(levels.length===1){s.level=0;s.effort=levels[0].effort;s.decision={source:"configured",reason:"single-tier",requestedEffort:s.effort};s.routeAbort=null;__tweakccRouterSave(s);return {sid:s.sid,generation:generation,turn:turn};}
  try{if(body)decision=await __tweakccRouterDeadline(async function(){var key=await __tweakccRouterApiKey();if(!key){failure="credential-unavailable";return null}if(controller.signal.aborted||__tweakccRouterSyncSelection()!==selected||s.generation!==generation||s.turn!==turn)return null;
    var response=await fetch("https://api.typesafe.ai/v1/systemone",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify(body),signal:controller.signal,redirect:"error"});
    if(!response.ok){failure="http-"+response.status;return null}
    var reader=response.body.getReader(),chunks=[],size=0;try{for(;;){var part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();return null}chunks.push(part.value)}}finally{reader.releaseLock()}
    failure="invalid-response";return __tweakccRouterDecision(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  },controller,settings.timeout)}catch(e){if(controller.signal.aborted)failure="timeout";}
  if(__tweakccRouterSyncSelection()!==selected||s!==globalThis.__tweakccRouter||s.generation!==generation||s.turn!==turn)return;
  var middle=levels.findIndex(function(level){return level.effort==="medium"});if(middle<0)middle=Math.min(1,levels.length-1);
  var level=decision?decision.level:middle,source=decision?"jev":"fallback",reason=decision?"classified":failure;
  s.level=level;s.effort=levels[level].effort;s.decision={source:source,reason:reason,requestedEffort:decision?levels[decision.level].effort:null,confidence:decision?decision.confidence:null};s.model=selected;s.routeAbort=null;__tweakccRouterSave(s);
  if(process.env.TWEAKCC_ROUTER_DEBUG)try{process.stderr.write("[tweakcc-router] provider=jev effort="+s.effort+" source="+source+" reason="+reason+" requested="+s.decision.requestedEffort+" confidence="+s.decision.confidence+"\n")}catch(e){}
  return {sid:s.sid,generation:generation,turn:turn};
}
globalThis.__tweakccRouterSyncSelection=__tweakccRouterSyncSelection;
globalThis.__tweakccRouterState=__tweakccRouterState;
globalThis.__tweakccRouterClassify=__tweakccRouterClassify;
globalThis.__tweakccRouterObserve=__tweakccRouterObserve;
globalThis.__tweakccRouterInvalidate=__tweakccRouterInvalidate;
`
  );
};
