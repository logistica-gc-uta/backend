import {
  HTTP_METHODS,
  buildValidators,
  collectRefs,
  loadOpenApi,
  resolvePointer,
} from './shop-openapi-contract.js';

/**
 * Validación del documento OpenAPI candidato de Shop (CI-SHOP-001 v1.2). No toca base de datos ni red:
 * comprueba que el contrato sea coherente antes de usarlo como autoridad en las pruebas de contrato.
 */
describe('OpenAPI candidato de Shop v1.2: el documento es válido y coherente', () => {
  const doc = loadOpenApi();
  const operations = Object.entries(doc.paths).flatMap(([route, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => ({ route, method, op: item[method] })),
  );

  it('declara OpenAPI 3.1 y la base real /api/v1', () => {
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.servers?.[0]?.url).toMatch(/\/api\/v1$/);
  });

  it('toda referencia $ref apunta a algo que existe', () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(100);
    const broken = refs.filter(({ ref }) => !ref.startsWith('#/') || resolvePointer(doc, ref) === undefined);
    expect(broken).toEqual([]);
  });

  it('cada operación tiene operationId único, respuesta de éxito y esquema de seguridad definido', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { route, method, op } of operations) {
      const successes = Object.keys(op.responses ?? {}).filter((status) => /^2\d\d$/.test(status));
      expect({ route, method, hasSuccess: successes.length > 0 }).toEqual({ route, method, hasSuccess: true });
      for (const requirement of op.security ?? []) {
        for (const scheme of Object.keys(requirement)) expect(doc.components.securitySchemes).toHaveProperty(scheme);
      }
    }
  });

  it('los parámetros de ruta están declarados y las operaciones con cuerpo definen su esquema', () => {
    for (const { route, method, op } of operations) {
      const placeholders = [...route.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = [...(doc.paths[route]!['parameters'] ?? []), ...(op.parameters ?? [])]
        .map((p: any) => (p.$ref ? resolvePointer(doc, p.$ref) : p))
        .filter((p: any) => p.in === 'path')
        .map((p: any) => p.name);
      expect({ route, method, missing: placeholders.filter((name) => !declared.includes(name)) }).toEqual({ route, method, missing: [] });
      if (op.requestBody?.required) {
        const schemas = Object.values(op.requestBody.content ?? {}).map((media: any) => media.schema);
        expect({ route, method, schemas: schemas.length > 0 && schemas.every(Boolean) }).toEqual({ route, method, schemas: true });
      }
    }
  });

  it('todos los esquemas compilan como JSON Schema 2020-12', () => {
    const validators = buildValidators(doc);
    for (const name of Object.keys(doc.components.schemas)) expect(() => validators.byName(name)).not.toThrow();
  });

  it('expone los endpoints de Shop que las pruebas de contrato necesitan', () => {
    for (const route of ['/shop/products', '/shop/checkout/quote', '/shop/checkout', '/shop/orders/{id}/receipt', '/shop/settings', '/admin/shop-settings']) {
      expect(doc.paths).toHaveProperty([route]);
    }
  });
});
