import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

/** Carga y valida el OpenAPI 3.1 candidato de Shop (CI-SHOP-001 v1.2) para usarlo en pruebas de contrato. */
export const OPENAPI_FILE = path.resolve(process.cwd(), 'docs/REGALIA-SHOP-OPENAPI-v1.2.yaml');
const BASE = 'https://regalia.test/openapi';

export type OpenApiDocument = {
  openapi: string;
  servers?: { url: string }[];
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};

export const loadOpenApi = (): OpenApiDocument => parse(readFileSync(OPENAPI_FILE, 'utf8')) as OpenApiDocument;

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Recorre todo el documento y devuelve las referencias `$ref` con su ubicación. */
export function collectRefs(node: unknown, pointer = '#'): { pointer: string; ref: string }[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => collectRefs(child, `${pointer}/${i}`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
      key === '$ref' && typeof value === 'string' ? [{ pointer, ref: value }] : collectRefs(value, `${pointer}/${key}`),
    );
  }
  return [];
}

export const resolvePointer = (doc: unknown, ref: string): unknown =>
  ref.replace(/^#\//, '').split('/').reduce<any>((node, part) => node?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], doc);

export function buildValidators(doc: OpenApiDocument) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const strict: Record<string, RegExp> = {
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    date: /^\d{4}-\d{2}-\d{2}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
  };
  // Formatos del contrato: los conocidos se validan de verdad; el resto (int32, binary…) solo se admiten.
  for (const format of new Set(JSON.stringify(doc.components).match(/"format":"([^"]+)"/g)?.map((m) => m.slice(10, -1)) ?? [])) {
    ajv.addFormat(format, strict[format] ?? true);
  }
  ajv.addSchema({ $id: BASE, components: doc.components });
  const byName = (name: string): ValidateFunction => {
    const validate = ajv.getSchema(`${BASE}#/components/schemas/${name}`);
    if (!validate) throw new Error(`Esquema '${name}' no existe en el contrato`);
    return validate;
  };
  return {
    byName,
    /** Valida un cuerpo real contra el esquema que el contrato declara para `método ruta estado`. */
    forResponse(method: string, pathTemplate: string, status: number): { validate: ValidateFunction; schema: string } {
      const response = ((doc.paths[pathTemplate] ?? {})[method.toLowerCase()]?.responses ?? {})[String(status)];
      const ref: string | undefined = response?.content?.['application/json']?.schema?.$ref;
      if (!ref) throw new Error(`El contrato no declara un esquema $ref para ${method.toUpperCase()} ${pathTemplate} → ${status}`);
      const name = ref.split('/').pop()!;
      return { validate: byName(name), schema: name };
    },
  };
}

/** Texto legible de los errores de Ajv para que un fallo de contrato se entienda sin depurar. */
export const describeErrors = (validate: ValidateFunction): string =>
  (validate.errors ?? []).slice(0, 8).map((e) => `${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`).join('\n');
