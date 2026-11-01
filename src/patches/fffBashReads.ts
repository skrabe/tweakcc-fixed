import { escapeNonAscii } from '../utils';
import { showDiff } from './index';
import { hasFffShellIntegration } from './swapRipgrepForFff';

export const fffViewerSetup = (directory: string, wrapper: string): string => {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const checks = [
    wrapper,
    ...['cat', 'head', 'tail', 'sed'].map(
      reader => `${directory}/15/${reader}`
    ),
  ]
    .map(file => `[ -x ${quote(file)} ]`)
    .join(' && ');
  const exports =
    `export RG_FFF_VIEWER_DIR=${quote(directory)} RG_FFF_CONTEXT_ROOT="$PWD" ` +
    `PATH=${quote(directory)}:"$PATH"`;
  return (
    `if ${checks} && (set -u; : "$PATH" "$PWD"; ${exports}) >/dev/null 2>&1 ` +
    `&& RG_FFF_VIEWER_DIR=$(${quote(wrapper)} --viewer-mask 2>/dev/null); then ` +
    `case "$RG_FFF_VIEWER_DIR" in [1-9]|1[0-5]) ` +
    `if [ -d ${quote(directory)}/"$RG_FFF_VIEWER_DIR" ]; then ` +
    `export RG_FFF_VIEWER_DIR=${quote(directory)}/"$RG_FFF_VIEWER_DIR" RG_FFF_CONTEXT_ROOT="$PWD"; ` +
    'export PATH="$RG_FFF_VIEWER_DIR:$PATH"; fi;; esac; fi'
  );
};

export const writeFffBashReads = (
  file: string,
  directory: string,
  wrapper: string
): string | null => {
  if (!hasFffShellIntegration(file, wrapper)) {
    console.error(
      'patch: fffBashReads: managed fff shell integration is required'
    );
    return null;
  }
  if (file.includes('export RG_FFF_VIEWER_DIR=')) return file;
  const pattern =
    /;([$\w]+)\.push\((?:[$\w]+\?[$\w]+\(\):)?`eval \$\{([$\w]+)\}`\),\1\.push\(`pwd -P >\| /g;
  const matches = [...file.matchAll(pattern)];
  if (matches.length !== 1 || matches[0].index === undefined) {
    console.error(
      'patch: fffBashReads: failed to find unique Bash command evaluation'
    );
    return null;
  }
  const match = matches[0];
  const start = match.index!;
  const insertion = `${match[1]}.push(${escapeNonAscii(JSON.stringify(fffViewerSetup(directory, wrapper)))});`;
  const updated = file.slice(0, start + 1) + insertion + file.slice(start + 1);
  showDiff(file, updated, insertion, start + 1, start + 1);
  return updated;
};
