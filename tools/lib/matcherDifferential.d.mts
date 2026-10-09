export interface DifferentialFinding {
  id: string;
  index: number;
  detail: string;
}

export interface DifferentialTargetSummary {
  kind: 'synthetic' | 'bundle';
  label: string;
  file: string | null;
  version: string;
  total: number;
  checked: number;
  exercised: number;
  skippedBuild: number;
  skippedRegex: number;
  cached: number;
  mismatches: DifferentialFinding[];
  errors: Array<{ id: string; index: number; message: string }>;
  failures: string[];
  ok: boolean;
}

export interface DifferentialResult {
  ok: boolean;
  targets: DifferentialTargetSummary[];
  core: { file: string; key: string; modules: string[]; deps: string[] };
}

export function defaultWorkerCount(): number;
export function defaultCacheDir(): string;
export function buildCore(): Promise<DifferentialResult['core']>;
export function runMatcherDifferential(opts: {
  promptsFile: string;
  bundles?: string[];
  synthetic?: boolean;
  workers?: number;
  cache?: boolean;
  cacheDir?: string;
  log?: (line: string) => void;
}): Promise<DifferentialResult>;
