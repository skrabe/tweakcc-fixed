#!/usr/bin/env node
import { relaunchWithLargerHeap } from './heapGuard';

if (!(await relaunchWithLargerHeap())) {
  await import('./main');
}
