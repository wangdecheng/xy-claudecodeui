/**
 * ConfigService — loads and validates `config/customer-analysis.json` against
 * the JSON Schema in `config/json-schemas/customer-analysis.schema.json`.
 *
 * - Single in-memory payload (singleton)
 * - Uses ajv to validate
 * - Throws explicit errors (InvalidConfigError / ConfigFileNotFoundError)
 * - Hot reload lives in `watchConfig()` (see Task 1.3)
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type Ajv from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

import { findAppRoot, getModuleDir } from '@/utils/runtime-paths.js';

// ajv@6 supports draft-07 natively (newer ajv@8 needs explicit meta-schema).
// We use the project-level ajv peer (already installed as a transitive of
// @commitlint/config-validator) instead of pulling a new dep.
const require = createRequire(import.meta.url);
const AjvModule = require('ajv') as { default?: typeof Ajv } & typeof Ajv;
const AjvCtor: typeof Ajv = (AjvModule.default ?? AjvModule) as unknown as typeof Ajv;
const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const SCHEMA_ABS_PATH = path.join(APP_ROOT, 'config/json-schemas/customer-analysis.schema.json');

export type ConfigCustomer = {
  label: string;
  branch: string | null;
};

export type ConfigPayload = {
  status: 'OK' | 'INVALID';
  mtime: string;
  data: {
    customers: ConfigCustomer[];
    iterations: string[];
  };
  error?: string;
};

export class InvalidConfigError extends Error {
  readonly code = 'INVALID_CONFIG';
  readonly ajvErrors: ErrorObject[];

  constructor(message: string, ajvErrors: ErrorObject[] = []) {
    super(message);
    this.name = 'InvalidConfigError';
    this.ajvErrors = ajvErrors;
  }
}

export class ConfigFileNotFoundError extends Error {
  readonly code = 'CONFIG_FILE_NOT_FOUND';
  readonly path: string;

  constructor(filePath: string) {
    super(`Config file not found: ${filePath}`);
    this.name = 'ConfigFileNotFoundError';
    this.path = filePath;
  }
}

const SCHEMA_RELATIVE_PATH = 'config/json-schemas/customer-analysis.schema.json';

let cachedPayload: ConfigPayload | null = null;
let cachedValidator: ValidateFunction | null = null;

function resolveConfigPath(input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

function loadValidator(): ValidateFunction {
  if (cachedValidator) {
    return cachedValidator;
  }
  // Lazy sync read; schema file is small and rarely changes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const raw = fs.readFileSync(SCHEMA_ABS_PATH, 'utf8');
  const schema = JSON.parse(raw);
  const ajv = new AjvCtor({ allErrors: true, schemaId: 'auto' });
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

function formatAjvErrors(errors: ErrorObject[]): string {
  if (!errors.length) {
    return 'invalid config';
  }
  return errors
    .map((err) => {
      const dataPath = (err as ErrorObject & { dataPath?: string }).dataPath ?? err.instancePath ?? '/';
      const detail = err.params && Object.keys(err.params).length > 0
        ? ` (${JSON.stringify(err.params)})`
        : '';
      return `${dataPath} ${err.message ?? ''}${detail}`.trim();
    })
    .join('; ');
}

export async function loadConfig(filePath: string): Promise<ConfigPayload> {
  const resolved = resolveConfigPath(filePath);

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw new ConfigFileNotFoundError(resolved);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'JSON parse failed';
    throw new InvalidConfigError(`Failed to parse config JSON: ${message}`);
  }

  const validate = loadValidator();
  const valid = validate(parsed);
  if (!valid) {
    const formatted = formatAjvErrors(validate.errors ?? []);
    throw new InvalidConfigError(
      `Config validation failed at ${resolved}: ${formatted}`,
      validate.errors ?? [],
    );
  }

  const data = parsed as { customers: ConfigCustomer[]; iterations: string[] };
  const stat = await import('node:fs/promises').then(({ stat }) => stat(resolved));

  const payload: ConfigPayload = {
    status: 'OK',
    mtime: stat.mtime.toISOString(),
    data: {
      customers: data.customers.map((c) => ({ label: c.label, branch: c.branch })),
      iterations: [...data.iterations],
    },
  };

  cachedPayload = payload;
  return payload;
}

export function getConfig(): ConfigPayload {
  if (!cachedPayload) {
    throw new Error('Config not loaded yet. Call loadConfig() first.');
  }
  return cachedPayload;
}

export function resetConfig(): void {
  cachedPayload = null;
}

/**
 * Test-only helper. Allows tests / routes to seed a payload without going
 * through the file system.
 */
export function _setConfigForTests(payload: ConfigPayload | null): void {
  cachedPayload = payload;
}