import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const compatibility = resolve(root, 'types/prisma-legacy-rawsql-compat.d.ts');
// Immutable, pre-compatibility bytes; never regenerate these from a candidate.
const history = [
  {
    directory: '20261010T0526_route_lifecycle_foundation',
    id: 'backfill.legacy-route-stops',
    hashes: ['57aab23001d7e8c15df9253de636219ff10750b80e4e28ca02b643ad39d07fbd', '496d9e6568abaaaf7ff4a797e624b756ebef414e31d235001c6f6458629248a6', '8f06022eeed4f4d3540bf3144980756e5dd725a11d86245699213de8dcc34e00'],
    migrationHash: '8b41a571c3ea5f0cb6f07b73b64b21fef0057e38a4fcfd04e7ed2abe04555211',
  },
  {
    directory: '20261010T0549_route_lifecycle_integrity',
    id: 'route-lifecycle.integrity-guards',
    hashes: ['4728524bf14e6a152a484c8be48f5e6daa0f25517641de9728903d0dd558eb19', '6f3846dabe9c8c1dd45ea3f3d782c43e58e99e36c67bee7e7696822ec907437b', 'f6df4119dd726fe542555aa10c72fe6ba5c080a4d8832624b7ca8c4b8a647cab'],
    migrationHash: 'd1c10af0f6a830a7c7a3dfd3eb6ec841329f6445829d06e587812651f9024a1d',
  },
  {
    directory: '20261010T1345_route_lifecycle_coherence_t1e',
    id: 'route-lifecycle.coherence-guards',
    hashes: ['5588bf88ce70ca75cc3374b32da0036bc14c94ac05e91683f21b22c6ada28af5', '6d2b1dae3570339adaea8a3a4badb2291186fc93d0de5df8abd0b96e9a2a8c5e', 'f1fc30cd2602df25873764f14036cb51333d77526d3d6ed4ca568342358fea12'],
    migrationHash: '608095e0d46f07ad1f6b0ec6e09c3754e05c9819fce7654d32cb46f0bef5d19e',
  },
];
const migrationPaths = history.map((entry) => resolve(root, 'migrations/app', entry.directory, 'migration.ts'));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function literal(node: ts.Node): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
        throw new Error('Only literal historical properties are allowed');
      }
      if (Object.hasOwn(result, property.name.text)) throw new Error('Duplicate literal key');
      result[property.name.text] = literal(property.initializer);
    }
    return result;
  }
  throw new Error(`Nonliteral historical expression: ${ts.SyntaxKind[node.kind]}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Not JSON');
  return serialized;
}

function rawCalls(source: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'rawSql') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}

function operation(index: number): Record<string, unknown> {
  const source = ts.createSourceFile(migrationPaths[index], readFileSync(migrationPaths[index], 'utf8'), ts.ScriptTarget.Latest, true);
  const calls = rawCalls(source);
  if (calls.length !== 1) throw new Error('Expected exactly one historical rawSql');
  const value = literal(calls[0].arguments[0]);
  if (!record(value)) throw new Error('Expected operation literal');
  return value;
}

const configFile = ts.readConfigFile(resolve(root, 'tsconfig.json'), (path) => ts.sys.readFile(path));
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
if (config.errors.length) throw new Error('Invalid root tsconfig');
const options = { ...config.options, noEmit: true, incremental: false };

// Virtual source text only: no invalid fixtures on disk, no emit or migration import.
function program(roots: string[], virtual = new Map<string, string>()): ts.Program {
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  host.readFile = (file) => virtual.get(resolve(file)) ?? originalRead(file);
  host.fileExists = (file) => virtual.has(resolve(file)) || originalExists(file);
  host.getSourceFile = (file, languageVersion) => {
    const text = host.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  host.writeFile = () => { throw new Error('Compiler must not emit'); };
  return ts.createProgram(roots, options, host);
}

function diagnostics(candidate: ts.Program): readonly ts.Diagnostic[] {
  return ts.getPreEmitDiagnostics(candidate);
}
function messages(candidate: ts.Program): string[] {
  return diagnostics(candidate).map((entry) => `${entry.file ? relative(root, entry.file.fileName) : ''}: TS${entry.code} ${ts.flattenDiagnosticMessageText(entry.messageText, '\n')}`);
}

// This is a separate SQL/usage guard, NOT a claim that the overload validates SQL.
function legacyUsage(candidate: ts.Program): { accepted: string[]; rejected: string[] } {
  const checker = candidate.getTypeChecker();
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const source of candidate.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && resolve(declaration.getSourceFile().fileName) === compatibility) {
          const index = migrationPaths.indexOf(resolve(source.fileName));
          let matches = false;
          if (index >= 0 && node.arguments.length === 1) {
            try { matches = canonical(literal(node.arguments[0])) === canonical(operation(index)); }
            catch { matches = false; }
          }
          (matches ? accepted : rejected).push(relative(root, source.fileName));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { accepted, rejected };
}

const fixtures = new Map<string, string>();
const negativeNames: string[] = [];
function fixture(name: string, text: string, negative = true) {
  const path = resolve(root, `test/__virtual_legacy_${name}.ts`);
  fixtures.set(path, `import { rawSql } from '@prisma/orm-postgres/migration';\n${text}`);
  if (negative) negativeNames.push(path);
  return path;
}
const base = operation(0);
function changed(name: string, value: Record<string, unknown>) {
  fixture(name, `rawSql(${JSON.stringify(value)});`);
}
changed('wrong_id', { ...base, id: 'new.operation' });
changed('wrong_label', { ...base, label: 'Different label' });
const target = base.target;
if (!record(target) || !record(target.details)) throw new Error('Invalid baseline target');
changed('wrong_name', { ...base, target: { ...target, details: { ...target.details, name: 'other' } } });
changed('wrong_schema', { ...base, target: { ...target, details: { ...target.details, schema: 'private' } } });
changed('wrong_target', { ...base, target: { ...target, id: 'sqlite' } });
changed('wrong_class', { ...base, operationClass: 'destructive' });
changed('supplied_object_type', { ...base, target: { ...target, details: { ...target.details, objectType: 'function' } } });
for (const phase of ['precheck', 'execute', 'postcheck']) {
  const missing = { ...base };
  delete missing[phase];
  changed(`missing_${phase}`, missing);
  changed(`empty_${phase}`, { ...base, [phase]: [] });
  changed(`missing_sql_${phase}`, { ...base, [phase]: [{ description: 'Missing SQL' }] });
}
fixture('false_return', `const result = rawSql(${JSON.stringify(base)});\nconst required: string = result.target.details.objectType;\nexport { required };`);
fixture('strict_new_positive', `rawSql(${JSON.stringify({ ...base, id: 'new.strict.operation', target: { ...target, details: { ...target.details, objectType: 'table' } } })});`, false);
const outside = fixture('outside_known_path', `rawSql(${JSON.stringify(base)});`, false);
// A whitelisted identity with changed SQL still typechecks; the independent guard must reject it.
const originalSource = readFileSync(migrationPaths[0], 'utf8');
fixtures.set(migrationPaths[0], originalSource.replace('SELECT true AS result', 'SELECT false AS result'));

let current: ts.Program;
let synthetic: ts.Program;
let syntheticDiagnostics: readonly ts.Diagnostic[];
beforeAll(() => {
  current = program(config.fileNames);
  synthetic = program([...migrationPaths, compatibility, ...fixtures.keys()], fixtures);
  syntheticDiagnostics = diagnostics(synthetic);
}, 30000);

describe('narrow downstream legacy rawSql compatibility (not an upstream fix)', () => {
  it('reproduces three actual historical TS2741 errors without the overload', () => {
    const baseline = diagnostics(program(migrationPaths));
    expect(baseline.map((entry) => [entry.file?.fileName, entry.code])).toEqual(migrationPaths.map((path) => [path, 2741]));
    expect(baseline.every((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n').includes('objectType'))).toBe(true);
  }, 30000);

  it('semantically compiles the strict root including all three actual modules and MigrationCLI', () => {
    expect(config.options.strict).toBe(true);
    for (const path of migrationPaths) expect(current.getSourceFile(path)).toBeDefined();
    expect(messages(current)).toEqual([]);
  });

  it.each(history.map((entry, index) => ({ ...entry, index })))('freezes source, ops and manifest for $directory and matches literal SQL to ops', (entry) => {
    const directory = resolve(root, 'migrations/app', entry.directory);
    ['migration.ts', 'ops.json', 'migration.json'].forEach((file, index) => {
      expect(createHash('sha256').update(readFileSync(resolve(directory, file))).digest('hex')).toBe(entry.hashes[index]);
    });
    const manifest: unknown = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8'));
    expect(record(manifest) && manifest.migrationHash).toBe(entry.migrationHash);
    const ops: unknown = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8'));
    if (!Array.isArray(ops)) throw new Error('Expected canonical ops array');
    const matches = ops.filter((value: unknown) => record(value) && value.id === entry.id);
    expect(matches).toHaveLength(1);
    expect(canonical(operation(entry.index))).toBe(canonical(matches[0]));
  });

  it('allows only the three known canonical usages in the actual project by resolved overload', () => {
    expect(legacyUsage(current)).toEqual({ accepted: migrationPaths.map((path) => relative(root, path)), rejected: [] });
  });

  it.each(negativeNames.map((path) => [relative(root, path), path]))('rejects semantic negative fixture %s', (_name, path) => {
    const errors = syntheticDiagnostics.filter((entry) => entry.file?.fileName === path);
    expect(errors.length).toBeGreaterThan(0);
    // Not a missing import or parser failure: these are argument/return type failures.
    expect(errors.every((entry) => [2769, 2339, 2322, 2741, 2345, 2353].includes(entry.code))).toBe(true);
  });

  it('keeps the original strict overload for new operations', () => {
    const path = resolve(root, 'test/__virtual_legacy_strict_new_positive.ts');
    expect(syntheticDiagnostics.filter((entry) => entry.file?.fileName === path)).toEqual([]);
  });

  it('rejects changed SQL and copied identities outside known paths through the separate usage guard', () => {
    const result = legacyUsage(synthetic);
    // TypeScript can resolve a recovery signature even for invalid calls;
    // those remain rejected too, rather than becoming a guard bypass.
    expect(result.rejected.sort()).toEqual([
      relative(root, migrationPaths[0]), relative(root, outside),
      ...negativeNames.map((path) => relative(root, path)),
    ].sort());
    expect(result.accepted.sort()).toEqual(migrationPaths.slice(1).map((path) => relative(root, path)).sort());
    for (const path of [...migrationPaths, outside]) {
      expect(syntheticDiagnostics.filter((entry) => entry.file?.fileName === path)).toEqual([]);
    }
  });
});
