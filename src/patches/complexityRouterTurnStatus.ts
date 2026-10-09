import { showDiff } from './index';

export const ROUTER_TURN_STATUS_RUNTIME = `
function __tweakccRouterMessageKey(messages){
  if(!Array.isArray(messages))return;
  for(var i=messages.length-1;i>=0;i--){var m=messages[i],c=m?.message?.content??m?.content;if(m?.type!=="user"||m.isMeta||typeof m.uuid!=="string")continue;if(typeof c==="string"||Array.isArray(c)&&c.some(p=>p?.type==="text"||p?.type==="image")&&!c.some(p=>p?.type==="tool_result"))return m.uuid}
}
var __tweakccRouterTurnHistory=new Map();
globalThis.__tweakccRouterRecordTurn=function(messages,options,effort,resolution){
  if(options.agentId||!(options.querySource?.startsWith("repl_main_thread")||options.querySource==="sdk"))return;
  var key=__tweakccRouterMessageKey(messages);if(!key)return;
  if(!resolution||resolution.effort!==effort){__tweakccRouterTurnHistory.delete(key);return}
  var decision=globalThis.__tweakccRouter?.decision,source=decision?.source;
  var confidence=source==="jev"&&typeof decision.confidence==="number"&&Number.isFinite(decision.confidence)&&decision.confidence>=0&&decision.confidence<=1?decision.confidence:void 0;
  __tweakccRouterTurnHistory.set(key,{effort:effort,source:["fallback","pinned","omitted"].includes(source)?source:"router",...(confidence!==void 0?{confidence:confidence}:{})});
  if(__tweakccRouterTurnHistory.size>256)__tweakccRouterTurnHistory.delete(__tweakccRouterTurnHistory.keys().next().value);
};
globalThis.__tweakccRouterSnapshotTurn=function(messages){
  var snapshot=__tweakccRouterTurnHistory.get(__tweakccRouterMessageKey(messages));return snapshot?{...snapshot}:void 0;
};
`;

export const writeComplexityRouterTurnStatus = (
  oldFile: string
): string | null => {
  if (oldFile.includes('function __tweakccRouterMessageKey(')) return oldFile;
  if (!oldFile.includes('subtype:"turn_duration"')) return oldFile;

  const factory = oldFile.match(
    /function ([$\w]+)\(([$\w]+)((?:,[$\w]+){3,4})\)\{return\{type:"system",subtype:"turn_duration",durationMs:\2,/
  );
  // 2.1.288+: the request-site call also passes `carriedEffort:CARRY`, and a
  // second counterfactual call passes `carriedEffort:null` for telemetry. Only
  // the real call (a bound carried-effort var) is the request site.
  const request = oldFile.match(
    /([$\w]+)\(\(\)=>(([$\w]+)\(([$\w]+),([$\w]+)\.effortValue,\{turnEffort:\5\.turnEffort,hookEffortValue:\5\.hookEffortValue(?:,carriedEffort:(?!null\})[$\w]+)?\}\))\)/
  );
  const renderer = oldFile.match(
    /children:`\$\{([$\w]+)\} for \$\{([$\w]+)\}\$\{([$\w]+)\?` \\xB7 done \$\{\3\}`:""\}`/
  );
  if (!factory || !request || !renderer) {
    console.error(
      'patch: complexityRouter: failed to find turn status anchors'
    );
    return null;
  }
  const requestPrefix = oldFile.slice(0, request.index);
  // 2.1.288+: the options param is destructured as `{modelFacts:F,...REST}`;
  // REST is the options object the alias spreads.
  const query = [
    ...requestPrefix.matchAll(
      /function\*[$\w]+\(([$\w]+),[$\w]+,[$\w]+,[$\w]+,[$\w]+,(?:([$\w]+)|\{(?:[$\w]+:[$\w]+,)*\.\.\.([$\w]+)\})\)\{/g
    ),
  ].at(-1);
  const queryOptions = query ? (query[2] ?? query[3]) : undefined;
  const renderPrefix = oldFile.slice(
    Math.max(0, renderer.index! - 7000),
    renderer.index
  );
  const message = [
    ...renderPrefix.matchAll(
      /\{message:([$\w]+),addMargin:[$\w]+,verb:[$\w]+\}/g
    ),
  ].at(-1)?.[1];
  const escapeId = (id: string) => id.replace(/\$/g, '\\$');
  // 2.1.285+: the generator aliases its options param to a local
  // (`D=b===h.fallbackModel?h:{...h,fallbackModel:b}`) and the request site
  // reads that alias. The alias is the options object for the record call.
  const optionsAlias =
    !!query &&
    !!queryOptions &&
    (queryOptions === request[5] ||
      new RegExp(
        `[,{]${escapeId(request[5])}=[$\\w]+===${escapeId(queryOptions)}\\.fallbackModel\\?${escapeId(queryOptions)}:\\{\\.\\.\\.${escapeId(queryOptions)},`
      ).test(oldFile.slice(query.index, request.index)));
  if (!query || !optionsAlias || !message) {
    console.error('patch: complexityRouter: failed to find turn status scopes');
    return null;
  }
  // Up to 2.1.294 the factory takes a budget second, and so does every call.
  const budgetArg = factory[3].split(',').length === 5 ? '([$\\w]+),' : '()';
  // The message-list arg is a bare identifier, or (2.1.285+) a snapshot getter
  // expression like `H.transcript.getSnapshot()`.
  const calls = [
    ...oldFile.matchAll(
      new RegExp(
        `(?<![$\\w.])${factory[1].replace(/\$/g, '\\$')}\\(([$\\w]+(?:\\.durationMs)?),${budgetArg}([$\\w]+)\\(((?:[$\\w]+(?:\\([^()]*\\))?)(?:\\.[$\\w]+(?:\\([^()]*\\))?)*),([$\\w]+)\\)(,[$\\w]+\\.pendingBackgroundAgentCount,[$\\w]+\\.pendingWorkflowCount)?\\)`,
        'g'
      )
    ),
  ];
  if (calls.length === 0) {
    console.error(
      'patch: complexityRouter: failed to find turn status emission'
    );
    return null;
  }
  const changes = [
    {
      index: factory.index!,
      old: factory[0],
      replacement:
        ROUTER_TURN_STATUS_RUNTIME +
        factory[0].replace(
          '){return{',
          ',__tweakccRouterSnapshot){return{...(__tweakccRouterSnapshot?{tweakccRouter:__tweakccRouterSnapshot}:{}),'
        ),
    },
    {
      index: request.index!,
      old: request[0],
      replacement: `${request[1]}(()=>{globalThis.__tweakccRouterResolution=void 0;let __tweakccResolved=${request[2].slice(0, -1)},${request[5]});globalThis.__tweakccRouterRecordTurn?.(${query[1]},${request[5]},__tweakccResolved,globalThis.__tweakccRouterResolution);return __tweakccResolved})`,
    },
    {
      index: renderer.index!,
      old: renderer[0],
      replacement:
        renderer[0].slice(0, -1) +
        `\${${message}.tweakccRouter?.effort?" \\xB7 Router \\u2192 "+${message}.tweakccRouter.effort+(${message}.tweakccRouter.source==="fallback"?" (fallback)":${message}.tweakccRouter.source==="pinned"?" (pinned)":${message}.tweakccRouter.source==="omitted"?" (incomplete input)":typeof ${message}.tweakccRouter.confidence==="number"&&Number.isFinite(${message}.tweakccRouter.confidence)&&${message}.tweakccRouter.confidence>=0&&${message}.tweakccRouter.confidence<=1?" (confidence "+Math.round(${message}.tweakccRouter.confidence*100)+"%)":""):""}\``,
    },
    ...calls.map(call => ({
      index: call.index!,
      old: call[0],
      replacement:
        call[0].slice(0, -1) +
        `${call[6] ? '' : ',void 0,void 0'},globalThis.__tweakccRouterSnapshotTurn?.(${call[4]}))`,
    })),
  ].sort((a, b) => b.index - a.index);
  let file = oldFile;
  for (const change of changes) {
    const next =
      file.slice(0, change.index) +
      change.replacement +
      file.slice(change.index + change.old.length);
    showDiff(
      file,
      next,
      change.replacement,
      change.index,
      change.index + change.old.length
    );
    file = next;
  }
  return file;
};
