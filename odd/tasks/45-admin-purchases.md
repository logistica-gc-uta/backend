# Register ADMIN purchase with declared external payment (#45)

Objective: ADMIN records a sale already paid in cash or transfer, with mandatory buyer phone, optional distinct gift recipient, Shop money/hours/coverage, coherent stock/order/receipt, recoverable idempotency, owner/ADMIN receipt reads, and contact correction history. Branch: `feat/45-admin-purchases`. Base: `37050c02ceea940e03cb051a740258dc60e6391b`. Delivery: `ask-on-risk`. Runner: `pnpm test` (Jest ESM). Isolated mutative checks: owned PostgreSQL. No push/PR/merge/shared DB.

## Specs

S1. "ADMIN elige comprador registrado CLIENT o invitado; número del comprador obligatorio en ambos. Para regalo a otra persona permitir nombre y teléfono de destinatario separados; no inferir que el usuario tenga teléfono persistido."

S2. "Guardar en el pedido el contacto usado para esa entrega. Correcciones ADMIN conservan historial y no cambian comprobantes ni otros pedidos; no vincular invitados a cuentas por coincidencia de teléfono."

S3. "Registrar compra ya pagada externamente: efectivo o transferencia, declarada por ADMIN con identidad y fecha/hora del servidor. No exigir verificación bancaria, referencia obligatoria ni tarjeta simulada."

S4. "Usar los mismos precios, envío incluido sin cargo adicional, IVA simulado configurable y horario que Shop. Persistir importes y datos aplicados en el comprobante; cambios futuros no lo recalculan."

S5. "Compra nueva ADMIN emite comprobante comercial sin validez tributaria. Para cuenta registrada queda asociado al titular; para invitado ADMIN lo ve/imprime y lo comparte externamente si hace falta."

S6. "Actualizar pedido, ítems, stock y comprobante de manera coherente, con permisos y protección de concurrencia. No generar éxito o comprobante de una operación rechazada."

S7. "Adaptar el tipo de comprobante para distinguir pago externo declarado de tarjeta simulada sin pedir ni exponer datos de tarjeta en compras ADMIN."

S8. "Un regalo se registra para un cliente con cuenta y destinatario diferente: comprador ve pedido/comprobante; no se confunden teléfonos."

S9. "Transferencia declarada no significa banco verificado. Un artículo sin stock se rechaza sin pedido/comprobante parcial."

S10. "Con subtotal 7300 y tasa simulado 15%, envío 0: total 8395 centavos; modificar tasa luego no altera ese comprobante."

S11. "Definir recuperación de resultado incierto según mecanismos existentes para evitar ventas duplicadas; preservar comportamiento previo por pruebas."

S12. "Cubrir los ejemplos anteriores mediante las interfaces públicas pertinentes. Verificar respuestas, efectos persistidos y que los rechazos no dejan cambios parciales; registrar resultados reales."

S13. "Acordar y documentar los contratos/campos afectados antes de integrar con otro repositorio; no sustituir una API pendiente por datos ficticios de éxito."

S14. "Sin pasarela real, factura SRI, comprobación bancaria ni envíos automáticos. No cambiar pago simulado del Shop."

S15. "No ejecutar vaciados, seeds sobre entornos compartidos o despliegues por el solo hecho de implementar esta issue; obtener las autorizaciones aplicables."

## Tasks

- T0 [S1–S15] inline — D0 contract doc + this tracker + A01–A30 mapping — Risk: item 3 — `docs/admin-purchases-contract.md`
- T1 [S1–S3,S5–S7,S11] inline — Prisma models, SQL constraints, formal migration on isolated Postgres — Risk: items 1, 3, 4
- T2 [S4,S10,S12,S14] inline — reuse Shop cents/VAT/shipping0; golden 7300+1095+0=8395; hours/coverage unchanged — Risk: item 3
- T3 [S1,S3–S6,S8–S12] inline — ADMIN sale transaction, idempotency/recovery, public create — Risk: items 2, 3, 4
- T4 [S5,S7,S8,S12–S14] inline — CLIENT-owner and ADMIN receipt reads, payment variants — Risk: items 2, 3
- T5 [S1,S2,S12,S13] inline — ADMIN contact correction + audit — Risk: items 2, 3, 4
- T6 [S4–S7,S11–S15] inline — consumers/fixtures/Newman/CI-equivalent gates — Risk: items 3, 5
- T7 [S1–S15] inline — independent verification + D7 report — Risk: items 1–4 as named

## A# → task → public interface (D0)

| A# | Task | Public interface |
| --- | --- | --- |
| A01–A08, A14–A19 | T3 | `POST /api/v1/orders/admin` + `GET /api/v1/orders/admin/purchase-attempts/:idempotencyKey` |
| A09–A13 | T2+T3 | same create + receipt reread |
| A20–A22 | T4 | `GET /api/v1/shop/orders/:id`, `GET /api/v1/shop/orders/:id/receipt`, `GET /api/v1/orders/:id/receipt` |
| A23–A25 | T5 | `PATCH /api/v1/orders/:id/contact`, `GET /api/v1/orders/:id/contact-history` |
| A26 | T1+T3 | isolated Postgres constraints |
| A27 | T6 | existing Shop/Orders tests |
| A28–A30 | T0+T6+T7 | docs/OpenAPI, inventory, CI gates |

## Log

L1. User authorized exclusive backend #45 on `feat/45-admin-purchases` from `37050c0`, mandatory read of `.pi/handoffs/issue-45.source.json`, `.plan.md` through `## Log`, `.md`, `.baseline.log`. No push/PR/merge/shared DB/deploy. Local commits allowed by harness.

L2. D0 recorded in `docs/admin-purchases-contract.md` (technical choices within issue rules; no business-rule change consulted).
