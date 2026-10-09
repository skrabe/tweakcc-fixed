// Worker for tools/lib/matcherDifferential.mjs. Loads the bundled differential
// core once, holds one target's content at a time (a target's chunks are queued
// contiguously, so each bundle is read once per worker), and answers chunks.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const core = await import(pathToFileURL(workerData.coreFile).href);

let loadedTarget = -1;
let content = null;

parentPort.on('message', async task => {
  if (task.target !== loadedTarget) {
    content = null;
    content = task.file === null ? null : fs.readFileSync(task.file, 'utf8');
    loadedTarget = task.target;
  }
  const results = [];
  for (const { i, pieces } of task.items) {
    try {
      results.push({
        i,
        r: await core.checkPromptDifferential(pieces, task.version, content),
      });
    } catch (err) {
      results.push({
        i,
        r: {
          status: 'error',
          message: (err && (err.stack || err.message)) || String(err),
        },
      });
    }
  }
  parentPort.postMessage({ target: task.target, results });
});

parentPort.postMessage({ ready: true });
