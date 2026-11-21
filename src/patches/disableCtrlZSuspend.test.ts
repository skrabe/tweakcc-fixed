import { describe, expect, it, vi } from 'vitest';

import { writeDisableCtrlZSuspend } from './disableCtrlZSuspend';

// Trimmed from CC 2.1.295 chunk-x31wb8sb.js (Ink input loop).
const EXCERPT =
  'if(T.kind==="paste"){n.props.dispatchPasteEvent(T.text);continue}' +
  'if(T.name==="z"&&T.ctrl&&tYn()){n.handleSuspend();continue}' +
  'if(n.handleInput(T.sequence),T.name==="wheelup"||T.name==="wheeldown"||T.name==="mouse"){}';

describe('writeDisableCtrlZSuspend', () => {
  it('short-circuits the Ctrl-Z suspend check', () => {
    const result = writeDisableCtrlZSuspend(EXCERPT);

    expect(result).toBe(
      EXCERPT.replace('if(T.name==="z"', 'if(!1&&T.name==="z"')
    );
  });

  it('short-circuits the 2.1.330 props.terminal.handleSuspend shape', () => {
    const excerpt =
      'if(Y.kind==="paste"){h.props.dispatchPasteEvent(Y.text,h.pressedAt);continue}' +
      'if(Y.name==="z"&&Y.ctrl&&mjr()){h.props.terminal.handleSuspend();continue}' +
      'if(h.handleInput(Y.sequence),Y.name==="wheelup"||Y.name==="wheeldown"){}';
    const result = writeDisableCtrlZSuspend(excerpt);

    expect(result).toBe(
      excerpt.replace('if(Y.name==="z"', 'if(!1&&Y.name==="z"')
    );
    expect(result).toContain(
      '{h.props.terminal.handleSuspend();continue}if(h.handleInput(Y.sequence)'
    );
    expect(writeDisableCtrlZSuspend(result!)).toBe(result);
  });

  it('returns null when the anchor is absent', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(writeDisableCtrlZSuspend('if(T.name==="x"){}')).toBeNull();
    spy.mockRestore();
  });
});
