const RESIGN_WARNING =
  /^Warning: Failed to re-sign binary\.[^\n]*\n(?:[ \t]+at [^\n]*[^{\n]\n)*(?:[ \t]+at [^\n]*\{\n(?:[ \t][^\n]*\n)*\}\n)?/gm;

export const normalizeLog = (text, macho) => {
  const withoutResign = macho ? text.replace(RESIGN_WARNING, '') : text;
  return withoutResign
    .replace(
      /\/tmp\/tweakcc-native-[A-Za-z0-9]{6}/g,
      '/tmp/tweakcc-native-XXXXXX'
    )
    .replace(
      /^([ \t]+at )(?:async )?\S+ \(file:\/\/\S*\/dist\/\S+:\d+:\d+\)$/gm,
      '$1<dist frame>'
    )
    .replace(/^([ \t]+at )file:\/\/\S*\/dist\/\S+:\d+:\d+$/gm, '$1<dist frame>')
    .replace(/builds\/[0-9a-f]{40}/g, 'builds/SHA')
    .replace(/-[A-Za-z0-9_-]{8}\.mjs/g, '-HASH.mjs')
    .replace(/\b\d+(\.\d+)?m?s\b/g, 'Ns')
    .split('\n')
    .filter(line => !(macho && /codesign/i.test(line)))
    .join('\n');
};
