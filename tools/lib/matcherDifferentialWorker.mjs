// Worker for tools/lib/matcherDifferential.mjs. Loads the bundled differential
// core once, decodes one target's bytes at a time from the shared memory the
// runner hashed (a target's chunks are queued contiguously, so each bundle is
// decoded once per worker), and answers chunks. It never reads the file: the
// bytes it checks must be the bytes the cache key was computed from.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const core = await import(pathToFileURL(workerData.coreFile).href);

let loadedTarget = -1;
let content = null;

parentPort.on('message', async task => {
  if (task.target !== loadedTarget) {
    content = null;
    const bytes = workerData.contents[task.target];
    content =
      bytes === null
        ? null
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString(
            'utf8'
          );
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
