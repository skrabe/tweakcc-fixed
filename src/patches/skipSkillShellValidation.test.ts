import { describe, expect, it, vi } from 'vitest';

import { writeSkipSkillShellValidation } from './skipSkillShellValidation';

// Real CC 2.1.295 excerpts from chunk-53bsrq2x.js.
const PLUGIN_CALLER =
  'Nt??Vh(ko.permissionLayers))),Sne())sn=RL(sn);else sn=await whe(sn,{...ko,getAppState:DM(ko,to())},`/${e}`,en);return[{t';
const SKILL_CALLER =
  '${CLAUDE_EFFORT}",$A(ibe(_e)??Mn.options.mainLoopModel,qh(Mn),nt??Vh(Mn.permissionLayers))),lTr(Me,Te)&&Sne())to=RL(to);else if(dTr(Me))to=await whe(to,{...Mn,getAppState:DM(Mn,nn())},`/${e}`,ct);return[{type:"text",text:to}]}};return so}as';
const EXPAND_FN =
  'async function whe(e,n,r,s){if(n.options.readOnlySkillLoad)return RL(e,qPe);let h=e;if(s==="bash"&&!Cl())throw Error(`Skill ${r} requires bash (\\`shell: bash\\` in frontmatter) but Git Bash was not found. Install Git for Windows (https://git-scm.com/downloads/win), or change the skill\'s frontmatter to \\`shell: powershell\\`.`);let y=s==="powershell"&&US()?_un():Cl()?vi:_un(),S=n.toolUseId??`${yun()}${jtt}`,w=pun(),H=un(n.options.tools,y.name)!==void 0,G=w&&de(n).mode==="auto"&&H?n.promptShellHandOff:void 0,V=w&&(G!==void 0||!0);if(de(n).servedCall===!0&&de(n).mode==="auto"&&G===void 0)return RL(e,qPe);let Y=H?n.options:{...n.options,tools:[...n.options.tools,y]},he=[];if(await Promise.all(tTr(e,y,r).map(async({raw:_e,command:ke,at:be},Te)=>{let Re={...n,innerCall:!0,toolUseId:`${S}${Plr}${Te}`,promptShellHandOff:void 0};try{let Ce={...n,options:Y,forPromptShellCommand:V,promptShellHandOff:void 0},Me=await Fu(y,{command:ke},Ce,Ec({content:[]}),""),Fe=Me.behavior==="ask"||Me.behavior==="deny"&&Me.decisionReason?.type==="asyncAgent",Ge=!1,Je=G!==void 0&&(Fe||Ge);if(i("tengu_prompt_shell_permission",{behavior:d(Me.behavior),mode:d(de(n).mode),evaluatedAs:d(de(Ce).mode),decisionReasonType:ue(Me.decisionReason?.type),handedToModel:Je,handedOffOnAllow:Ge}),Je){let ct={command:ke.trim(),tool:y.name};he.push({index:Te,at:be,entry:ct}),h=h.replace(_e,()=>f3e(Te));return}if(Me.behavior!=="allow"){if(t(`Shell command permission check failed for command in ${r}: ${ke}. Error: ${Me.message}`),co(Re.session))throw t(`prompt shell permission denial: ${Me.message||"Permission denied"}`,{level:"error"}),new OO(`Shell command permission check failed for pattern "${_e}" (detail withheld on this connection)`);throw new OO(`Shell command permission check failed for pattern "${_e}": ${Me.message||"Permission denied"}`)}let{data:tt}=await y.call({command:ke},Re),dt=await dqe(y,tt,yun(),rh(Re.session),Re.storageV5),nt=typeof dt.content==="string"?dt.content:kun(tt.stdout,tt.stderr);h=h.replace(_e,()=>nt)}';

const CHUNK = PLUGIN_CALLER + ';' + SKILL_CALLER + ';' + EXPAND_FN;

// Real CC 2.1.325 excerpts (prompt-shell check block and own-skill caller).
const CHECK_325 =
  'if(ot.behavior!=="allow"){t(`Shell command permission check failed for command in ${r}: ${xe}. Error: ${ot.message}`);let Nt=ot.decisionReason?.type==="asyncAgent"?ot.decisionReason.ask?.decisionReason:ot.decisionReason;if(tt&&yt&&(Nt?.type==="other"||Nt?.type==="subcommandResults"))throw new yx(`Couldn\'t run \\`${xe}\\` for ${r}. This folder or one above it looks like a bare git repository that may not be yours, and git can run commands named in a repository\'s files. If you trust this folder, allow the git commands this needs, for example with /permissions, and try again.`);if(jo(Xe.session))throw t(`prompt shell permission denial: ${ot.message||"Permission denied"}`,{level:"error"}),new yx(`Shell command permission check failed for pattern "${Ae}" (detail withheld on this connection)`);let ln=Nt?.type==="subcommandResults"?[...Nt.reasons.values()][0]?.decisionReason:Nt,Ht=ln?.type==="other"&&ln.bashMissKind==="git-untrusted-checkout"?ln.reason:ot.message;throw new yx(`Shell command permission check failed for pattern "${Ae}": ${Ht||"Permission denied"}`)}';
const CALLER_325 =
  'ous(st,Ne)&&PRe())to=YG(to);else if(rus(st))to=await C1e(to,{...fo,getAppState:VB(fo,mo())},`/${e}`,Mt);if(tt&&!Xe)to=`${aus(tt)}\n\n${to}`';
const CHUNK_325 =
  'async function C1e(e,n,r,s,h){if(n.options.readOnlySkillLoad)return YG(e,BJe);let y=e;' +
  CHECK_325 +
  'n0(E.name);};' +
  CALLER_325;

describe('writeSkipSkillShellValidation', () => {
  it('marks only the own-skill call and lets "ask" through for it', () => {
    const result = writeSkipSkillShellValidation(CHUNK);

    expect(result).not.toBeNull();
    expect(result).toContain(
      'else if(dTr(Me))to=await whe(to,{tweakccOwnSkill:!0,...Mn,getAppState:DM(Mn,nn())}'
    );
    expect(result).toContain(
      'else sn=await whe(sn,{...ko,getAppState:DM(ko,to())}'
    );
    expect(result).toContain(
      'if(Me.behavior!=="allow"&&!(n.tweakccOwnSkill&&Me.behavior==="ask")){if(t(`Shell command permission check failed'
    );
  });

  it('handles the five-parameter expansion function (CC 2.1.310)', () => {
    const chunk = CHUNK.replace(
      'async function whe(e,n,r,s){',
      'async function whe(e,n,r,s,h){'
    ).replace('`/${e}`,en);', '`/${e}`,en,r);');
    const result = writeSkipSkillShellValidation(chunk);

    expect(result).toContain(
      'else if(dTr(Me))to=await whe(to,{tweakccOwnSkill:!0,...Mn,getAppState:DM(Mn,nn())}'
    );
    expect(result).toContain(
      'if(Me.behavior!=="allow"&&!(n.tweakccOwnSkill&&Me.behavior==="ask")){'
    );
  });

  it('keeps the bare-repo guard live for own skills (CC 2.1.325)', () => {
    const result = writeSkipSkillShellValidation(CHUNK_325);

    expect(result).not.toBeNull();
    expect(result).toContain(
      'else if(rus(st))to=await C1e(to,{tweakccOwnSkill:!0,...fo,getAppState:VB(fo,mo())}'
    );
    expect(result).toContain(
      'if(ot.behavior!=="allow")tweakccAsk:{t(`Shell command permission check failed for command in'
    );
    expect(result).toContain(
      'try again.`);if(n.tweakccOwnSkill&&ot.behavior==="ask")break tweakccAsk;if(jo(Xe.session))throw'
    );
    expect(result).toContain(
      'if(tt&&yt&&(Nt?.type==="other"||Nt?.type==="subcommandResults"))throw new yx(`Couldn\'t run'
    );
    expect(writeSkipSkillShellValidation(result!)).toBe(result);

    const block = result!.slice(
      result!.indexOf('if(ot.behavior!=="allow")'),
      result!.indexOf('n0(E.name)')
    );
    const run = new Function(
      'n',
      'ot',
      'tt',
      'yt',
      'r',
      'xe',
      'Ae',
      'Xe',
      't',
      'jo',
      'yx',
      `${block}return "ran";`
    );
    const exec = (own: boolean, behavior: string, bareRepo: boolean) =>
      run(
        own ? { tweakccOwnSkill: true } : {},
        { behavior, message: 'm', decisionReason: { type: 'other' } },
        bareRepo,
        behavior === 'ask',
        '/s',
        'git status',
        '!`git status`',
        { session: {} },
        () => {},
        () => false,
        Error
      );

    expect(exec(true, 'ask', false)).toBe('ran');
    expect(() => exec(true, 'ask', true)).toThrow('bare git repository');
    expect(() => exec(true, 'deny', false)).toThrow(
      'Shell command permission check failed for pattern'
    );
    expect(() => exec(false, 'ask', false)).toThrow(
      'Shell command permission check failed for pattern'
    );
  });

  it('returns null for modules without the prompt-shell check', () => {
    expect(writeSkipSkillShellValidation(PLUGIN_CALLER)).toBeNull();
  });

  it('fails when the own-skill call is missing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeSkipSkillShellValidation(PLUGIN_CALLER + EXPAND_FN)).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});
