#!/usr/bin/env node

const fs = require('fs');
const parser = require('@babel/parser');

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validateInput(text, minLength = 500) {
  if (!text || typeof text !== 'string') return false;

  // ////////////////
  // What to include.
  // ////////////////

  // Context about Git status
  if (text.startsWith('This is the git status')) return true;

  // Include the system reminder accompanying every Read tool.
  if (text.includes('Whenever you read a file, you should consider whether it')) return true;

  // Another prompt smaller then 500 characters that should be included
  if (text.includes('IMPORTANT: Assist with authorized security testing'))
    return true;

  // Markdown skill / data-doc / section-headed prompt: any text 300+
  // chars starting with `# Header`, `## Header`, or `### Header` is a real
  // prompt regardless of the English-keyword heuristic below. Catches
  // skills (`# Anthropic CLI`), section-prefixed system prompts
  // (`\n## Insights\n...`), and shorter section fragments like
  // `# Focus mode`, `# Language`, `# Autonomous loop tick`.
  if (text.length >= 300 && /^\s*#{1,3} [A-Z]/.test(text)) return true;

  // Tool / agent / skill descriptions that open with a directive verb and
  // are bullet-heavy markdown (fail the sentence-pattern check below).
  // Catches TaskUpdate / TaskList / TaskGet / Agent / claude-code-guide
  // descriptions, schedule skill, settings-locations skill, etc.
  if (text.length >= 400 && /^\s*(Use this (?:tool|skill|agent)|Your strengths:|Your version of Claude Code|<system-reminder>)/.test(text)) return true;

  // Specific medium-length prompts (400–500c) that open with directive
  // patterns. Each entry is anchored to text confirmed unique in 2.1.141
  // cli.js. `trimStart` lets us catch leading-whitespace variants (some
  // cli.js templates open with `\n` before the directive verb).
  const ts = text.trimStart();
  if (text.includes('Provide a concise response based only on the content above')) return true;
  if (ts.startsWith('Find elements on the page using natural language')) return true;
  if (ts.startsWith('Your plan has been submitted to the team lead for approval')) return true;
  if (ts.startsWith("I'm sending this plan to Ultraplan to be refined remotely")) return true;
  if (text.includes('If the user asks about "ultrareview" or how to run it')) return true;
  if (text.includes('If they want a one-time run (e.g., "once at 3pm"')) return true;
  if (ts.startsWith('You are an interactive agent that helps users')) return true;
  if (ts.startsWith("You are an agent for Claude Code, Anthropic's official CLI")) return true;

  // Very short interpolated fragments (under 100 chars) that ship in
  // cli.js. Bash-alt-* tool sub-descriptions and subagent-guidance.
  if (ts.startsWith('Edit files: Use ${')) return true;
  if (ts.startsWith('Read files: Use ${')) return true;
  if (ts.startsWith('Write files: Use ${')) return true;
  if (ts.startsWith('File search: Use ${')) return true;
  if (ts.startsWith('Content search: Use ${')) return true;
  if (ts.startsWith('Use the ${') && ts.includes('tool with specialized agents')) return true;
  if (ts.startsWith('Contents of ${') && ts.includes(':')) return true;

  // ////////////////
  // Short-prompt allow-list: distinctive substrings of prompts under 500
  // chars that the length check below would otherwise drop. Compiled by
  // cross-referencing Piebald's published 2.1.140 JSON against the cli.js
  // for 2.1.141 — each entry is a substring confirmed unique enough not to
  // false-positive within the prompts set.
  //
  // Mirrors PR #731 (Add include rules for short system prompt fragments)
  // from the upstream Piebald repo plus an additional batch we compiled
  // here. If PR #731 merges upstream, the overlapping entries will be
  // deduped on the next `git merge upstream/main`.
  // ////////////////

  // PR #731 — short fragments from the doing-tasks / tone-and-style / memory sections.
  if (text.includes('exploratory questions')) return true;
  if (text.includes('well-named identifiers already do that')) return true;
  if (text.includes('golden path and edge cases')) return true;
  if (text.includes('Prefer editing existing files')) return true;
  if (text.includes('Default to writing no comments')) return true;
  if (text.startsWith("Don't add features, refactor")) return true;
  if (text.includes('Only use emojis if the user explicitly')) return true;
  if (text === 'Your responses should be short and concise.') return true;
  if (text.includes('Do not use a colon before tool calls')) return true;
  if (text.includes('What NOT to save in memory')) return true;

  // Agent / skill / system / tool short prompts that ship in 2.1.141 and earlier.
  if (text.includes('Generate a short kebab-case name (2-4 wo')) return true;
  if (text.includes('The user just ran /insights to generate')) return true;
  if (text.includes('You are highly capable and often allow u')) return true;
  if (text.includes('The user will primarily request you to p')) return true;
  if (text.includes('If the user asks for help or wants to gi')) return true;
  if (text.includes('Avoid backwards-compatibility hacks like')) return true;
  if (text.includes("Don't add error handling, fallbacks, or")) return true;
  if (text.includes('Be careful not to introduce security vul')) return true;
  if (text.includes('Do not retry failing commands ')) return true;
  if (text.includes('When referencing specific functions or p')) return true;
  if (text.includes('You have exited plan mode. You can now')) return true;
  if (text.includes('minder>Warning: the file exists but the')) return true;
  if (text.includes('minder>Warning: the file exists but is s')) return true;
  if (text.includes('hook stopped continuation:')) return true;
  if (text.includes('<new-diagnostics>The following new diagn')) return true;
  if (text.includes('This session is being continued from ano')) return true;
  if (text.includes("The task tools haven't been used recentl")) return true;
  if (text.includes("The TodoWrite tool hasn't been used rece")) return true;
  if (text.includes('You have completed implementing the plan')) return true;
  if (text.includes('ion: Output text directly (NOT echo/prin')) return true;
  if (text.includes('Before running destructive ope')) return true;
  if (text.includes('Never skip hooks (--no-verify)')) return true;
  if (text.includes('Prefer to create a new commit ')) return true;
  if (text.includes('Try to maintain your current working dir')) return true;
  if (text.includes('DO NOT use newlines to separat')) return true;
  if (text.includes('Executes a given bash command and return')) return true;
  if (text.includes('If the commands are independen')) return true;
  if (text.includes('Always quote file paths that c')) return true;
  if (text.includes('If a command fails due to sandbox restri')) return true;
  if (text.includes('You should always default to running com')) return true;
  if (text.includes('Access denied to specific paths outside')) return true;
  if (text.includes('Evidence of sandbox-caused failures incl')) return true;
  if (text.includes('Network connection failures to non-white')) return true;
  if (text.includes('"Operation not permitted" errors for fil')) return true;
  if (text.includes('Unix socket connection er')) return true;
  if (text.includes('Briefly explain what sandbox restriction')) return true;
  if (text.includes('A specific command just failed and you s')) return true;
  if (text.includes('All commands MUST run in sandbox mode -')) return true;
  if (text.includes('Commands cannot run outside the sandbox')) return true;
  if (text.includes('Do not suggest adding sensitive paths li')) return true;
  if (text.includes('Treat each command you execute with `dan')) return true;
  if (text.includes('This will prompt the user for permission')) return true;
  if (text.includes('When you see evidence of sandbox-caused')) return true;
  if (text.includes('Immediately retry with `dangerouslyDisab')) return true;
  if (text.includes('For temporary files, always use the `$TM')) return true;
  if (text.includes("Use ';' only when you need to run comman")) return true;
  if (text.includes('If the commands depend on each')) return true;
  if (text.includes('If you must sleep, keep the du')) return true;
  if (text.includes('If waiting for a background ta')) return true;
  if (text.includes('Do not sleep between commands ')) return true;
  if (text.includes('external process, use a check command (e')) return true;
  if (text.includes('You may specify an optional timeout in m')) return true;
  if (text.includes('If your command will create new director')) return true;
  if (text.includes('The working directory persists between c')) return true;
  if (text.includes('Writes a file to the local filesystem, o')) return true;

  // System-reminder short fragments and a few specific tool-description /
  // system-prompt fragments shipped under 500 chars in 2.1.141.
  if (text.startsWith('Stop hook blocking error from command')) return true;
  if (text.startsWith('The user opened the file ') && text.includes('in the IDE')) return true;
  if (text.includes('The user selected the lines ')) return true;
  if (text.includes('The user has expressed a desire to invoke the agent')) return true;
  if (text.startsWith('A plan file exists from plan mode at:')) return true;
  if (text.includes('IMPORTANT: Avoid using this tool to run')) return true;
  if (text.startsWith('Break down and manage your work with the')) return true;

  // ////////////////
  // What to exclude.
  // ////////////////

  // In one specific case, some of the TUI code shows up in the prompts files.  Exclude it.
  if (text.includes('.dim("Note:')) return false;

  // CLI help text for `claude mcp add` is not a prompt - it's user-facing documentation.
  if (text.startsWith('Add an MCP server to Claude Code.')) return false;

  // Skip the warning about keybindings when connecting to a remote server.
  if (text.includes('Cannot install keybindings from a remote')) return false;

  // HTML output from the /insights report (and similar). Not a prompt.
  if (text.startsWith('<!DOCTYPE html>') || text.startsWith('<html')) return false;
  if (/^\s*<h\d[\s>]/.test(text)) return false;

  // `claude` CLI help screens (Remote Control feature et al). Not prompts.
  if (text.includes('Remote Control - Control local sessions from claude.ai/code'))
    return false;

  // JSON-schema-style config option descriptions (not prompts). Pattern:
  // `When true, ...` followed by `Equivalent to setting <flag>: false on
  // the API.` These appear as tool/server config docstrings.
  if (
    text.startsWith('When true, ') &&
    text.includes('Equivalent to setting ') &&
    text.includes(' on the API')
  )
    return false;

  if (text.length < minLength) return false;

  const first10 = text.substring(0, 10);
  if (first10.startsWith('AGFzbQ') || /^[A-Z0-9+/=]{10}$/.test(first10)) {
    return false;
  }

  const sample = text.substring(0, 500);
  const words = sample.split(/\s+/).filter(w => w.length > 0);

  if (words.length === 0) return false;

  const uppercaseWords = words.filter(
    w => w === w.toUpperCase() && /[A-Z]/.test(w)
  );
  const uppercaseRatio = uppercaseWords.length / words.length;

  if (uppercaseRatio > 0.6) {
    return false;
  }

  const lowerText = text.toLowerCase();
  const hasYou = lowerText.includes('you');
  const hasAI = lowerText.includes('ai') || lowerText.includes('assistant');
  const hasInstruct =
    lowerText.includes('must') ||
    lowerText.includes('should') ||
    lowerText.includes('always');

  if (!hasYou && !hasAI && !hasInstruct) {
    return false;
  }

  const sentencePattern = /[.!?]\s+[A-Z\(]/;
  const hasSentences = sentencePattern.test(text);
  if (!hasSentences) {
    return false;
  }

  const avgWordLength =
    words.reduce((sum, w) => sum + w.length, 0) / words.length;

  if (avgWordLength > 15) {
    return false;
  }

  const spaceCount = (sample.match(/\s/g) || []).length;
  const spaceRatio = spaceCount / sample.length;

  if (spaceRatio < 0.1) {
    return false;
  }

  return true;
}

// Decode JS unicode/hex escape sequences in template-literal raw source.
// Surgical: only handles \uHHHH, \u{X+}, \xHH. Preserves `\\` so literal
// `\\uHHHH` source (= backslash + u + four hex chars at runtime) isn't
// accidentally interpreted as an escape. Other escapes (\n, \t, \", \`)
// are kept raw to match the storage format Piebald's published JSONs use.
function decodeUnicodeEscapesInPiece(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      // Double-backslash: copy both literally so the next char isn't read as an escape.
      if (s[i + 1] === '\\') {
        out += '\\\\';
        i += 2;
        continue;
      }
      if (s[i + 1] === 'u') {
        if (s[i + 2] === '{') {
          const close = s.indexOf('}', i + 3);
          if (close > -1) {
            const hex = s.substring(i + 3, close);
            if (/^[0-9a-fA-F]+$/.test(hex)) {
              out += String.fromCodePoint(parseInt(hex, 16));
              i = close + 1;
              continue;
            }
          }
        } else if (i + 6 <= s.length) {
          const hex = s.substring(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
        }
      }
      if (s[i + 1] === 'x' && i + 4 <= s.length) {
        const hex = s.substring(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}

function extractStrings(filepath, minLength = 500) {
  const code = fs.readFileSync(filepath, 'utf-8');

  const ast = parser.parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  const stringData = [];

  const traverse = node => {
    if (!node || typeof node !== 'object') return;

    // Extract string literals
    if (node.type === 'StringLiteral') {
      if (validateInput(node.value, minLength)) {
        stringData.push({
          name: '',
          id: '',
          description: '',
          pieces: [node.value],
          identifiers: [],
          identifierMap: {},
          start: node.start,
          end: node.end,
        });
      }
    }

    // Extract template literals
    if (node.type === 'TemplateLiteral') {
      const { expressions } = node;

      // Extract the entire template content directly from source (excluding backticks)
      const contentStart = node.start + 1; // After opening backtick
      const contentEnd = node.end - 1; // Before closing backtick
      const fullContent = code.substring(contentStart, contentEnd);

      // Validate before processing
      if (!validateInput(fullContent, minLength)) {
        return;
      }

      // Collect all identifiers with their positions
      const allIdentifiers = []; // Array of {name, start, end} sorted by position

      for (let i = 0; i < expressions.length; i++) {
        const expr = expressions[i];

        const traverseExpr = (exprNode, isTopLevel = true) => {
          if (!exprNode || typeof exprNode !== 'object') return;

          if (exprNode.type === 'Identifier' && isTopLevel) {
            allIdentifiers.push({
              name: exprNode.name,
              start: exprNode.start - contentStart,
              end: exprNode.end - contentStart,
            });
          }

          if (exprNode.type === 'CallExpression') {
            traverseExpr(exprNode.callee, true);
            if (exprNode.arguments) {
              exprNode.arguments.forEach(arg => traverseExpr(arg, true));
            }
            return;
          }

          if (exprNode.type === 'MemberExpression') {
            traverseExpr(exprNode.object, true);
            return;
          }

          if (exprNode.type === 'TemplateLiteral') {
            if (exprNode.expressions) {
              exprNode.expressions.forEach(nestedExpr =>
                traverseExpr(nestedExpr, true)
              );
            }
            return;
          }

          if (exprNode.type === 'ObjectExpression') {
            if (exprNode.properties) {
              exprNode.properties.forEach(prop => {
                if (prop.value) {
                  traverseExpr(prop.value, false);
                }
              });
            }
            return;
          }

          for (const key in exprNode) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            const value = exprNode[key];
            if (Array.isArray(value)) {
              value.forEach(v => traverseExpr(v, true));
            } else if (value && typeof value === 'object') {
              traverseExpr(value, true);
            }
          }
        };

        traverseExpr(expr, true);
      }

      // Sort identifiers by position
      allIdentifiers.sort((a, b) => a.start - b.start);

      // Build pieces array by splitting around identifiers, keeping ${ and }
      const pieces = [];
      const identifierList = [];
      const identifierMap = {};

      let lastPos = 0;

      for (const id of allIdentifiers) {
        // Find the ${ before this identifier (search backwards from id.start)
        let beforeIdentifier = fullContent.substring(lastPos, id.start);

        // Find the } after this identifier (search forwards from id.end)
        // We need to find the matching closing brace for the interpolation
        let afterIdentifierStart = id.end;

        // Add the piece including everything up to and including just before the identifier
        pieces.push(beforeIdentifier);

        // Add identifier to the list
        identifierList.push(id.name);

        // Add to map if not already there
        if (!identifierMap[id.name]) {
          identifierMap[id.name] = '';
        }

        lastPos = id.end;
      }

      // Add the final piece after the last identifier
      pieces.push(fullContent.substring(lastPos));

      // Decode unicode/hex escapes in each piece. Template-literal raw source
      // stores `—` as 6 literal chars; the cooked runtime value is the
      // em-dash. Decoding here keeps our pieces[] byte-aligned with the
      // pristine prompt content in cli.js's parse tree — same format Piebald's
      // pipeline produces, so merge name-carryover works across versions.
      for (let pi = 0; pi < pieces.length; pi++) {
        pieces[pi] = decodeUnicodeEscapesInPiece(pieces[pi]);
      }

      // Label encode the identifiers
      const uniqueVars = [...new Set(identifierList)];
      const varToLabel = {};
      uniqueVars.forEach((varName, idx) => {
        varToLabel[varName] = idx;
      });

      const labelEncodedIdentifiers = identifierList.map(
        varName => varToLabel[varName]
      );
      const labelEncodedMap = {};
      Object.keys(varToLabel).forEach(varName => {
        labelEncodedMap[varToLabel[varName]] = '';
      });

      stringData.push({
        name: '',
        id: '',
        description: '',
        pieces,
        identifiers: labelEncodedIdentifiers,
        identifierMap: labelEncodedMap,
        start: node.start,
        end: node.end,
      });
    }

    // Recursively traverse
    for (const key in node) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;

      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(traverse);
      } else if (value && typeof value === 'object') {
        traverse(value);
      }
    }
  };

  traverse(ast);

  // Filter out strings that are subsets of other strings
  // Step 1: Sort by start index (ascending), then by end index (descending)
  // This puts earliest strings first, and among strings with same start, longest first
  stringData.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return b.end - a.end;
  });

  // Step 2: Track seen ranges and filter out subsets.
  // Exception: items starting immediately after `${` are interpolated
  // values inside a larger template — semantically distinct prompts that
  // happen to be nested. Don't drop them as subsets of the outer.
  const seenRanges = [];
  const filteredData = [];

  for (const item of stringData) {
    const isInterpolated =
      item.start >= 2 &&
      code[item.start - 2] === '$' &&
      code[item.start - 1] === '{';

    const isSubset =
      !isInterpolated &&
      seenRanges.some(
        range => item.start >= range.start && item.end <= range.end
      );

    if (!isSubset) {
      filteredData.push(item);
      seenRanges.push({ start: item.start, end: item.end });
    }
  }

  return { prompts: filteredData };
}

function mergeWithExisting(newData, oldData, currentVersion) {
  if (!oldData || !oldData.prompts) {
    // No old data, add current version to all new prompts
    return {
      prompts: newData.prompts.map(item => ({
        ...item,
        version: currentVersion,
      })),
    };
  }

  // Helper to reconstruct content from pieces and identifiers
  const reconstructContent = item => {
    return item.pieces.join(''); // Don't actually insert the vairables.
  };

  // Fingerprint normalization: Piebald's pipeline stores source-form escapes
  // (`\'`, `\"`, `` \` ``) in StringLiteral pieces, while our extractor uses
  // babel's cooked node.value (escapes decoded). Strip these escape forms
  // before fingerprinting so the prefix compares equal across pipelines.
  const fpNormalize = s => s.replace(/\\(['"`\\])/g, '$1');

  // Fuzzy-fingerprint index: prompts whose content shifted slightly between
  // versions still have an unchanged opening. We index old prompts by their
  // normalized first 100 chars and drop collisions so we never carry over
  // the wrong name. Built once per merge — O(n) — and consulted only when
  // the strict content+identifier match fails.
  const FUZZY_PREFIX = 100;
  const FUZZY_MIN = 60;
  const fpCounts = new Map();
  const fpToOld = new Map();
  for (const oldItem of oldData.prompts) {
    if (!oldItem.id) continue; // no carryover value without a name
    const fp = fpNormalize(reconstructContent(oldItem)).slice(0, FUZZY_PREFIX);
    if (fp.length < FUZZY_MIN) continue;
    fpCounts.set(fp, (fpCounts.get(fp) || 0) + 1);
    fpToOld.set(fp, oldItem);
  }
  for (const [fp, count] of fpCounts) if (count > 1) fpToOld.delete(fp);

  const newPrompts = newData.prompts.map((newItem, idx) => {
    const newContent = reconstructContent(newItem);

    // Try to find a matching old item by content and label-encoded identifiers
    const matchingOld = oldData.prompts.find(oldItem => {
      const oldContent = reconstructContent(oldItem);
      if (newContent !== oldContent) return false;

      // Also compare label-encoded identifiers
      if (newItem.identifiers.length !== oldItem.identifiers.length)
        return false;
      return (
        JSON.stringify(newItem.identifiers) ===
        JSON.stringify(oldItem.identifiers)
      );
    });

    // If we found a match, copy over the metadata
    if (matchingOld) {
      // Prompt matches exactly
      // If old prompt has no version, use current version; otherwise use old version
      return {
        ...newItem,
        name: matchingOld.name,
        id: matchingOld.id || slugify(matchingOld.name),
        description: matchingOld.description,
        identifierMap: matchingOld.identifierMap,
        version: matchingOld.version || currentVersion,
      };
    }

    // Fuzzy match: same prompt across versions, content shifted by a few
    // chars. Carry over the identity (name/id/description/identifierMap)
    // and bump version since pieces changed.
    const fp = fpNormalize(newContent).slice(0, FUZZY_PREFIX);
    const fuzzyOld = fp.length >= FUZZY_MIN ? fpToOld.get(fp) : undefined;
    if (fuzzyOld) {
      const oldLen = reconstructContent(fuzzyOld).length;
      console.log(
        `Fuzzy-matched item ${idx} to "${fuzzyOld.name || fuzzyOld.id}" (${oldLen} → ${newContent.length} chars)`
      );
      return {
        ...newItem,
        name: fuzzyOld.name,
        id: fuzzyOld.id || slugify(fuzzyOld.name),
        description: fuzzyOld.description,
        identifierMap: fuzzyOld.identifierMap,
        version: currentVersion,
      };
    }

    // No exact match found - check if there's a prompt with same metadata but different content
    const similarOld = oldData.prompts.find(oldItem => {
      // Check if names match (not placeholder) as a heuristic for "same prompt, different content"
      return oldItem.name !== '' && oldItem.name === newItem.name;
    });

    if (similarOld && similarOld.version) {
      // Old prompt exists with a version and content changed - use current version
      console.log(
        `Content changed for "${newItem.name}", updating version from ${similarOld.version} to ${currentVersion}`
      );
      return {
        ...newItem,
        id: similarOld.id || slugify(similarOld.name),
        version: currentVersion,
      };
    }

    // Check if there's any old prompt without a version (we should add current version)
    const oldWithoutVersion = oldData.prompts.find(oldItem => !oldItem.version);

    // New prompt or old prompt didn't have version - add current version
    console.log(
      `No match for item ${idx}: ${JSON.stringify(newContent.slice(0, 100))}`
    );
    console.log();
    return {
      ...newItem,
      id: slugify(newItem.name),
      version: currentVersion,
    };
  });

  return { prompts: newPrompts };
}

// CLI
if (require.main === module) {
  const filepath = process.argv[2];

  if (!filepath) {
    console.error(
      'Usage: node promptExtractor.cjs <path-to-cli.js> [output-file]'
    );
    process.exit(1);
  }

  const outputFile = process.argv[3] || 'prompts.json';

  // Try to read existing output file
  let existingData = null;
  if (fs.existsSync(outputFile)) {
    try {
      const existingContent = fs.readFileSync(outputFile, 'utf-8');
      existingData = JSON.parse(existingContent);
      console.log(
        `Found existing output file with ${existingData.prompts?.length || 0} prompts`
      );
    } catch (err) {
      console.warn(
        `Warning: Could not parse existing output file: ${err.message}`
      );
    }
  }

  // Look for package.json alongside the input file
  const path = require('path');
  const inputDir = path.dirname(path.resolve(filepath));
  const packageJsonPath = path.join(inputDir, 'package.json');

  let version = null;
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      version = packageJson.version;
      console.log(`Found package.json with version ${version}`);
    } catch (err) {
      console.warn(`Warning: Could not parse package.json: ${err.message}`);
    }
  }

  // Helper functions to replace version strings with placeholder
  const replaceVersionInString = (str, versionStr) => {
    if (!versionStr) return str;
    // Escape dots for regex
    const escapedVersion = versionStr.replace(/\./g, '\\.');
    // Replace version with placeholder
    return str.replace(new RegExp(escapedVersion, 'g'), '<<CCVERSION>>');
  };

  // Helper function to replace BUILD_TIME timestamps with placeholder
  // BUILD_TIME is an ISO 8601 timestamp like "2025-12-09T19:43:43Z"
  const replaceBuildTimeInString = str => {
    // Match ISO 8601 timestamps in the format YYYY-MM-DDTHH:MM:SSZ
    // Only match when preceded by BUILD_TIME:" to avoid false positives
    return str.replace(
      /BUILD_TIME:"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"/g,
      'BUILD_TIME:"<<BUILD_TIME>>"'
    );
  };

  const replaceVersionInPrompts = (data, versionStr) => {
    return {
      ...data,
      prompts: data.prompts.map(prompt => ({
        ...prompt,
        pieces: prompt.pieces.map(piece => {
          let result = piece;
          // Replace BUILD_TIME first (always)
          result = replaceBuildTimeInString(result);
          // Then replace version if provided
          if (versionStr) {
            result = replaceVersionInString(result, versionStr);
          }
          return result;
        }),
      })),
    };
  };

  const result = extractStrings(filepath);
  // Replace version in newly extracted strings BEFORE merging
  const versionReplacedResult = replaceVersionInPrompts(result, version);

  const mergedResult = mergeWithExisting(
    versionReplacedResult,
    existingData,
    version
  );

  // Sort prompts by lexicographic order of pieces joined together (without interpolated vars)
  mergedResult.prompts.sort((a, b) => {
    const contentA = a.pieces.join('');
    const contentB = b.pieces.join('');
    return contentA.localeCompare(contentB);
  });

  // Remove start/end fields before writing
  mergedResult.prompts = mergedResult.prompts.map(({ start, end, ...rest }) => rest);

  // Add version as top-level field
  const outputData = {
    version,
    ...mergedResult,
  };

  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));

  console.log(`Extracted ${mergedResult.prompts.length} strings`);
  console.log(`Written to ${outputFile}`);
}

module.exports = extractStrings;
