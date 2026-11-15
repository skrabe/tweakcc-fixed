import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const real = p => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export const isMain = (moduleUrl, argv1 = process.argv[1]) =>
  Boolean(argv1) && real(fileURLToPath(moduleUrl)) === real(argv1);
