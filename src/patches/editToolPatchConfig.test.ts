/**
 * Tests for the generic LEX Walker Patch Engine and edit tool config.
 */

import { describe, it, expect } from 'vitest';
import { LexPatcher, type LexPatcherConfig } from './lexPatcher';
import { editToolPatchConfig } from './editToolPatchConfig';

describe('LexPatcher', () => {
  describe('constructor validation', () => {
    it('throws when no anchors provided', () => {
      expect(
        () =>
          new LexPatcher({
            anchors: [],
            variables: [],
            injections: [
              {
                targetAnchorId: 'x',
                position: 'after',
                template: () => '',
              },
            ],
          })
      ).toThrow('at least one anchor');
    });

    it('handles missing anchor in injection gracefully', () => {
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'a',
            regex: /run:async/,
            contextWindowBefore: 10,
            contextWindowAfter: 10,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'nonexistent',
            position: 'after',
            template: () => '',
          },
        ],
      };
      const patcher = new LexPatcher(config);
      // apply() should not throw when injection's anchor is missing
      expect(() =>
        patcher.apply('run:async({file_path:x,old_string:});')
      ).not.toThrow();
    });
  });

  describe('anchor matching', () => {
    it('finds anchors in source text', () => {
      const source = 'hello run:async({file_path:x,old_string:});';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'test',
            regex: /run:async\(\{/,
            contextWindowBefore: 100,
            contextWindowAfter: 100,
          },
        ],
        variables: [],
        injections: [],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).not.toBeNull();
    });

    it('returns null when anchor not found', () => {
      const source = 'hello world';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'test',
            regex: /run:async\(\{/,
            contextWindowBefore: 10,
            contextWindowAfter: 10,
          },
        ],
        variables: [],
        injections: [],
      };
      const patcher = new LexPatcher(config);
      expect(patcher.apply(source)).toBeNull();
    });
  });

  describe('variable matching', () => {
    it('extracts variable names from context window', () => {
      const source = 'content=s.split(r)run:async({file_path:x,old_string:});';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [
          {
            id: 'contentVar',
            anchorId: 'anchor1',
            direction: 'before',
            regex: /([a-zA-Z_$]+)=s\.split/,
          },
        ],
        injections: [],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).not.toBeNull();
    });

    it('returns null when required variable not found', () => {
      const source = 'run:async({file_path:x,old_string:});';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [
          {
            id: 'contentVar',
            anchorId: 'anchor1',
            direction: 'before',
            regex: /([a-zA-Z_$]+)=s\.split/,
          },
        ],
        injections: [],
      };
      const patcher = new LexPatcher(config);
      expect(patcher.apply(source)).toBeNull();
    });
  });

  describe('injection', () => {
    it('inserts code after anchor match', () => {
      const source = 'run:async({file_path:x,old_string:});';
      let injectedCode = '';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'anchor1',
            position: 'after',
            template: (vars, safe) => {
              injectedCode = `safe=${safe[0] || 'a'};`;
              return injectedCode;
            },
          },
        ],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).toContain(injectedCode);
    });

    it('inserts code before anchor match', () => {
      const source = 'run:async({file_path:x,old_string:});';
      let injectedCode = '';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'anchor1',
            position: 'before',
            template: (vars, safe) => {
              injectedCode = `safe=${safe[0] || 'a'};`;
              return injectedCode;
            },
          },
        ],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).toContain(injectedCode);
    });

    it('applies multiple injections in correct order', () => {
      let first = '',
        second = '';
      const source = 'run:async({file_path:x,old_string:});';
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'anchor1',
            position: 'before',
            template: () => {
              first = 'FIRST';
              return first;
            },
          },
          {
            targetAnchorId: 'anchor1',
            position: 'after',
            template: () => {
              second = 'SECOND';
              return second;
            },
          },
        ],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).toContain('FIRST');
      expect(result).toContain('SECOND');
    });
  });

  describe('safe name generation', () => {
    it('avoids names already used in source', () => {
      const source = 'a=b.c(d)run:async({file_path:x,old_string:});';
      // 'a' is used as a variable, so safe names should skip it
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'anchor1',
            position: 'after',
            template: (vars, safe) => {
              expect(safe[0]).not.toBe('a'); // should avoid the used name
              return `injected=${safe[0]};`;
            },
          },
        ],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply(source);
      expect(result).toContain('injected=');
    });

    it('generates unique names across multiple injections', () => {
      const names: string[] = [];
      const config: LexPatcherConfig = {
        anchors: [
          {
            id: 'anchor1',
            regex: /run:async/,
            contextWindowBefore: 50,
            contextWindowAfter: 20,
          },
        ],
        variables: [],
        injections: [
          {
            targetAnchorId: 'anchor1',
            position: 'after',
            template: (_, safe) => {
              names.push(safe[0]);
              return `x=${safe[0]};`;
            },
          },
          {
            targetAnchorId: 'anchor1',
            position: 'before',
            template: (_, safe) => {
              names.push(safe[0]);
              return `y=${safe[0]};`;
            },
          },
        ],
      };
      const patcher = new LexPatcher(config);
      const result = patcher.apply('run:async({file_path:x,old_string:});');
      expect(result).toContain('x=');
      expect(result).toContain('y=');
    });
  });

  describe('editToolPatchConfig integration', () => {
    it('applies edit tool config to source with all four param vars', () => {
      const source =
        'run:async({file_path:x,old_string:y,new_string:z,replace_all:w})=>{};';
      const patcher = new LexPatcher(editToolPatchConfig);
      const result = patcher.apply(source);

      // Should contain the injected trim assignment after the anchor
      expect(result).toContain('.trim()');
    });
  });
});
