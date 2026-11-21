export const EVERYTHING_GLOB_TITLE = 'Glob through Everything (Windows)';
export const EVERYTHING_GLOB_DESCRIPTION =
  'Requires voidtools Everything to be installed and running, plus its separate command-line tool (es.exe) on PATH; get both from voidtools.com. ' +
  "Answers the Glob tool from Everything's index instead of walking the disk with ripgrep. Falls back to ripgrep only when Everything is not running or finds no files at all. " +
  'Files in folders Everything excludes or has not indexed are silently left out of Glob results.';
export const EVERYTHING_GLOB_MISSING_ES =
  'es.exe was not found on PATH, so this cannot be turned on. Install the Everything command-line interface from voidtools.com.';
