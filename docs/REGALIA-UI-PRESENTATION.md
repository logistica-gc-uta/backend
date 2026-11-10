# REGALÍA — Presentación de la UI

**Decisión aprobada · 08-11-2026:** simplificar el texto de la interfaz cliente y conservar aquí la explicación técnica. Aprobación literal: «le quitamos pero si tiene que estar documentado.» Antecedente literal y alcance normativo en la [adenda §22 del contrato consolidado](CI-SHOP-001-v1.2-CONSOLIDADO.md#22-adenda-de-presentación-aprobada--08-11-2026).

## Texto cliente y semántica conservada

| Se retira de la vista cliente | Se presenta | Se conserva técnicamente |
|---|---|---|
| «Pago simulado» y «Sin cobro» en el CTA | «Pago», «Confirmar pago» | Simulador, sin pasarela real; restricciones de entorno y guardas backend (§§9, 16 del contrato) |
| Calificaciones repetidas de tarjeta ficticia | Número de tarjeta, titular, vencimiento y CVV | Solo fixtures autorizados; ninguna tarjeta real. Valores y reglas autoritativos en §9, sin duplicarlos aquí |
| «IVA simulado» y ensayos sobre HALF_UP/backend/SRI | «IVA» con tasa e importe | Centavos enteros, redondeo y autoridad backend; impuesto simulado configurable y snapshot histórico (§§1, 8, 10) |
| Leyenda de comprobante sin validez tributaria | «Comprobante de compra» | `disclaimer` y su literal exacto permanecen en API y snapshot persistido (§11); no se renderizan, tampoco al imprimir. No se cambia OpenAPI |

No se añade capacidad bancaria o tributaria, ni se habilita el simulador fuera de demo/test. Los importes, fixtures, autenticación, seguridad, idempotencia y snapshots inmutables no cambian. La aprobación afecta al diseño de la vista cliente; esta tarea solo actualiza documentación y prototipos independientes, no implementa frontend de producción.

## Frontera del boceto

- La barra superior externa al contenido cliente dice «Boceto · datos de muestra».
- «Herramientas del boceto» agrupa controles de revisión, escenarios manuales y restricciones de prueba; no es ayuda comercial ni parte de la UI cliente propuesta. En pago, la advertencia de usar únicamente tarjetas ficticias queda accesible junto a los fixtures. Los errores de validación siguen siendo útiles y honestos.
- Los prototipos solo trabajan en memoria, sin backend, cobros ni persistencia. Los resúmenes entre pantallas siguen siendo independientes. El resultado aprobado es una variante seleccionada para revisión, no una confirmación bancaria.
- Se conserva la advertencia de no repetir un pago pendiente y la consulta informa que no hay backend: nunca convierte el estado en aprobado. Los mensajes sin JavaScript mantienen las limitaciones reales.
- Las pantallas 01, 02, 03, 05 y 09 no se modifican con esta decisión.

## Límites de aprobación

No se autoriza publicar, desplegar ni cambiar el modo de producción. Antes de una exposición pública futura, una persona responsable debe revisar por separado los requisitos legales y de comunicación aplicables; este documento no certifica cumplimiento legal ni fiscal.
