// Please see the note about writing patches in ./index
//
// /plan exit — open the ExitPlanMode approval dialog without asking the model
// (backported from Piebald-AI/tweakcc, https://github.com/Piebald-AI/tweakcc/issues/777).
//
// Reaching the plan-approval dialog (and its "Yes, clear context" option)
// normally takes a model turn that calls the ExitPlanMode tool. This patch
// teaches the `/plan` command an `exit` argument that renders that same dialog
// directly. The dialog applies its own choice the way it does for the tool:
// "clear context" options queue the "Implement the following plan" message
// themselves; for the keep-context options this patch queues it, switching to
// the chosen mode; "Tell Claude what to change" sends the feedback while
// staying in plan mode.
//
// ```diff
//  async function se(i,o,f){let{getAppState:y,setAppState:E}=o,h=y().toolPermissionContext.mode,d=h!=="plan";
// +if(f.trim()==="exit"){if(d)return i("Not in plan mode."),null;…return e(globalThis.__tweakccPlanExitDialog,{payload,answer,wouldTakeAnswer})}
//  if(d)vpe(h,"plan"),…
// ```
//
// The handler, the dialog and the command definition sit in different modules
// of the virtual bundle, and the dialog is not exported. A name added to a
// module's import list is never bound in the native build, so the dialog is
// published on `globalThis` beside its definition. The handler's module is
// loaded lazily from the dialog's module, so the bridge is set before any
// `/plan exit` runs.

import { parseExpressionAt } from 'acorn';

import { showDiff } from './index';

const MODULE_MARK = '/*@@TWEAKCC_MODULE:';
// `__tweakcc` is the repo's patched-binary marker prefix.
const BRIDGE = 'globalThis.__tweakccPlanExitDialog';

/** The ExitPlanMode dialog: function Bot({payload:h,answer:A,wouldTakeAnswer:L}){…showClearContextOnPlanAccept */
const DIALOG_PATTERN =
  /function ([$\w]+)\(\{payload:[$\w]+,answer:[$\w]+,wouldTakeAnswer:[$\w]+\}\)\{[^]{0,800}?\.showClearContextOnPlanAccept\)/;

/** Start of the /plan handler, up to "already in plan mode?". */
const HANDLER_PATTERN =
  /async function [$\w]+\(([$\w]+),([$\w]+),([$\w]+)\)\{let\{getAppState:[$\w]+,setAppState:([$\w]+)\}=\2,([$\w]+)=[$\w]+\(\)\.toolPermissionContext\.mode,([$\w]+)=\5!=="plan";/;

/** Plan path and contents: let c=gv();Wh(c);let C=await YKe(void 0,o.storageV5); */
const PLAN_PATTERN =
  /let ([$\w]+)=([$\w]+)\(\);[$\w]+\(\1\);let ([$\w]+)=await ([$\w]+)\(void 0,[$\w]+\.storageV5\);/;

/** createUserMessage: xe({content:l,origin:{kind:"human"}}) */
const USER_MESSAGE_PATTERN =
  /([$\w]+)\(\{content:[$\w]+,origin:\{kind:"human"\}\}\)/;

/** JSX factory: e(b,{planContent:… */
const JSX_PATTERN = /([$\w]+)\([$\w]+,\{planContent:/;

/** Cloud-session branch: if(Ht()){if(!Ka())return i(d?"Enabled plan mode":"Already in plan mode."),null; */
const CLOUD_PATTERN =
  /if\(([$\w]+)\(\)\)\{if\(![$\w]+\(\)\)return [$\w]+\([$\w]+\?"Enabled plan mode":"Already in plan mode\."\),null;/;

const PATCHED_MARKER = '.trim()==="exit"){if(';

const ARGUMENT_HINT =
  'name:"plan",description:"Enable plan mode or view the current session plan",argumentHint:"[open|';

/** The virtual-bundle module holding `at`: [start, end) of its text. */
const moduleSpan = (file: string, at: number): [number, number] => {
  const start = file.lastIndexOf(MODULE_MARK, at);
  const next = file.indexOf(MODULE_MARK, start === -1 ? 0 : start + 1);
  return [start === -1 ? 0 : start, next === -1 ? file.length : next];
};

const splice = (
  file: string,
  at: number,
  length: number,
  text: string
): string => {
  const newFile = file.slice(0, at) + text + file.slice(at + length);
  showDiff(file, newFile, text, at, at + length);
  return newFile;
};

/** Offset just past the dialog's function declaration. */
const dialogEnd = (file: string, start: number): number | null => {
  try {
    return parseExpressionAt(file, start, { ecmaVersion: 'latest' }).end;
  } catch {
    return null;
  }
};

interface Handler {
  insertAt: number;
  insertion: string;
}

const buildHandler = (file: string): Handler | null => {
  const handler = file.match(HANDLER_PATTERN);
  if (!handler || handler.index === undefined) return null;
  const [start, end] = moduleSpan(file, handler.index);
  const module = file.slice(start, end);
  const plan = module.match(PLAN_PATTERN);
  const userMessage = module.match(USER_MESSAGE_PATTERN)?.[1];
  const jsx = module.match(JSX_PATTERN)?.[1];
  if (!plan || !userMessage || !jsx) return null;

  const [, done, ctx, args, setAppState, , notPlan] = handler;
  const [, , planPath, , readPlan] = plan;
  // Cloud sessions keep the plan in the cloud workspace, and the dialog's
  // answer queues a local message, so decline there instead of reading a
  // stale or missing local plan.
  const cloud = module.match(CLOUD_PATTERN)?.[1];
  const insertion =
    `if(${args}.trim()==="exit"){` +
    `if(${notPlan})return ${done}("Not in plan mode."),null;` +
    (cloud
      ? `if(${cloud}())return ${done}("/plan exit is not available in cloud sessions. Ask Claude to exit plan mode."),null;`
      : '') +
    `if(typeof ${BRIDGE}!=="function")return ${done}("/plan exit could not find the plan approval dialog."),null;` +
    `let tccPath=${planPath}(),tccPlan=await ${readPlan}(void 0,${ctx}.storageV5);` +
    `if(!tccPlan)return ${done}("No plan written yet. Use shift+tab to leave plan mode."),null;` +
    `return ${jsx}(${BRIDGE},{` +
    `payload:{plan:tccPlan,planFilePath:tccPath,usage:${ctx}.messages?.findLast((tccMsg)=>tccMsg.type==="assistant"&&tccMsg.message?.usage)?.message.usage},` +
    `wouldTakeAnswer:()=>!0,` +
    `answer:(tccAnswer)=>{` +
    // "Yes, clear context" options queue their own message and return deny.
    `if(tccAnswer.behavior==="allow"){let tccMode=tccAnswer.permissionUpdates?.find((tccUpdate)=>tccUpdate.type==="setMode")?.mode;` +
    `${setAppState}((tccState)=>({...tccState,initialMessage:{message:${userMessage}({content:"Implement the following plan:\\n\\n"+(tccAnswer.updatedInput?.plan??tccPlan),origin:{kind:"auto-continuation"}}),...tccMode&&{mode:tccMode}}}))}` +
    `else if(tccAnswer.feedback)${setAppState}((tccState)=>({...tccState,initialMessage:{message:${userMessage}({content:tccAnswer.feedback,origin:{kind:"human"}})}}));` +
    `${done}(void 0,{display:"skip"});return!0}})}`;
  return { insertAt: handler.index + handler[0].length, insertion };
};

export const writePlanExitCommand = (oldFile: string): string | null => {
  if (oldFile.includes(PATCHED_MARKER)) return oldFile;

  // Locate every edit before making any, so a partial match never ships a
  // handler that points at an unpublished dialog.
  const dialog = oldFile.match(DIALOG_PATTERN);
  const publishAt =
    dialog && dialog.index !== undefined
      ? dialogEnd(oldFile, dialog.index)
      : null;
  if (!dialog || publishAt === null) {
    console.error(
      'patch: planExitCommand: failed to find the plan approval dialog'
    );
    return null;
  }
  const handler = buildHandler(oldFile);
  if (!handler) {
    console.error('patch: planExitCommand: failed to find the /plan handler');
    return null;
  }
  const hintAt = oldFile.indexOf(ARGUMENT_HINT);

  // Apply later offsets first so earlier ones stay valid.
  const edits = [
    { at: publishAt, text: `${BRIDGE}=${dialog[1]};` },
    { at: handler.insertAt, text: handler.insertion },
    ...(hintAt === -1
      ? []
      : [{ at: hintAt + ARGUMENT_HINT.length, text: 'exit|' }]),
  ].sort((a, b) => b.at - a.at);

  let file = oldFile;
  for (const { at, text } of edits) file = splice(file, at, 0, text);
  return file;
};
