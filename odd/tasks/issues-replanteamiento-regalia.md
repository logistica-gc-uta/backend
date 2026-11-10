# Issues del replanteamiento REGALÍA
Objetivo: revisar y crear issues en los tres repositorios autorizados, evitando duplicados y respetando sus formularios.
Destino GitHub y sesión autorizados; #35 se revisa al final. No publicar sin verificar políticas y contenido.

## Specs
- S1. «aa, pense que eran issue, entonces continua con la planificacion»
- S2. «tienes la autorizacion , continua»
- S3. «si, tienes autorizacion, pero tengo una duda en conversaciones anteriores si sabiar que repositorioas teniamos y los integrantes y sus roles pero ahora se me hace extaseno que me preguntes»
- S4. «la issue 13 se cerro porque ya estaba implementada pero la issue 35 toca modificar porque como vamos a crear nuevas issue con lo planteado hasta ahora , esa issue se va al ultimo»

- S5. «realiza esas mejorar en todas las issue» — ampliar contexto, situación actual, reglas y ejemplos, dependencias, exclusiones, criterios y pendientes sin inventar contratos.

- S6. «si esta bien. asigna las issue . o que falta para su asignacion» — reparto aceptado: backend Saimol-Uta #41/#42/#45/#48/#49/#51; MateoAuz #43/#44/#46/#47/#50/#52/#53; web kerly1811-mi #32–#39. Conservar QA #35 y móvil #6–#8.

## Tasks
- T9 [S6] HECHO — job-16 verificó sesión, permisos, cuentas asignables y 21 issues sin asignar; QA/móvil confirmados como preservar; commit: no aplica.
- T10 [S6] HECHO — job-17 confirmó 21 asignaciones con lectura posterior y contenido/estados/etiquetas preservados; commit: no aplica.
- T11 [S6] HECHO — journal verificado: 6 Saimol-Uta, 7 MateoAuz, 8 kerly1811-mi; 4 previas QA/móvil preservadas, cero resultados inciertos; commit: no aplica.
- T5 [S5] HECHO — 23 versiones actuales recuperadas; referencias backend verificadas por explorador; sin cambios remotos; commit: no aplica.
- T6 [S5] HECHO — 23 cuerpos revisados, 29 grupos NR trazados; ambigüedades corregidas y criterios conservados (uno de QA aclarado); revisión en odd/issues-replanteamiento-review/review.md; commit: no aplica.
- T7 [S5] HECHO — job-13 confirmó 23 ediciones con cuerpo exacto y metadata preservada; backend #35 procesada última; commit: no aplica.
- T8 [S5] HECHO — journal confirma 23 intentos/23 lecturas exactas, metadata intacta, #35 última y grafo de prerrequisitos sin ciclos; 29 grupos NR trazados. Sin pruebas de aplicación; commit: no aplica.
- T1 [S1–S3] HECHO — parent: identidad Saimol-Uta, 3 repos, issues habilitadas, plantillas y listados comprobados; commit: no aplica a publicación de issues.
- T2 [S1–S3] HECHO — parent: búsqueda por 21 temas y lectura del inventario completo; móvil #8 existente cubre fallo y retorno; nuevas candidatas describen cambios posteriores y no reabren funcionalidad anterior; commit: no aplica.
- T3 [S2–S3] HECHO — parent: 13 issues backend #41–#53 y 8 frontend #32–#39 publicadas y verificadas individualmente; móvil #8 no duplicada; commit: no aplica.
- T4 [S4] HECHO — parent: #35 backend actualizada al final mediante adenda preservando contenido; dependencias y evidencias añadidas, lectura verificada y estado OPEN conservado; commit: no aplica.

## Desglose provisional

Sin asignar responsables ni etiquetas protegidas; cada issue requiere búsqueda y lectura de vuelta. Los nombres son provisionales y las referencias de cierre previas se citan como contexto, no se reabren. #8 móvil ya cubre fallo y retorno y no se duplica.

- B1 backend: tienda única y configuración de cobertura.
- B2 backend: adaptar validación y contratos de pedidos de zona a cobertura.
- B3 backend: gestión ADMIN de perfiles de repartidores.
- B4 backend: ausencias por fecha y disponibilidad efectiva.
- B5 backend: compra ADMIN, pago externo declarado y comprobante.
- B6 backend: historial unificado y titularidad con comprobante opcional histórico.
- B7 backend: validar e integrar motor vial OSRM y gestionar indisponibilidad.
- B8 backend: planificación por horarios y métricas viales.
- B9 backend: limitar planificación/asignación a hoy y adaptar urgencias.
- B10 backend: retiro en tienda mediante acuerdo y confirmación.
- B11 backend: emergencia de ruta y recuperación física individual.
- B12 backend: pérdida, reemplazo e inventario seguro.
- B13 backend: preparación de configuración segura para producción.
- W1 web: gestión ADMIN de tienda y cobertura.
- W2 web: ubicación Shop sin zona fija y aviso de horario.
- W3 web: compra ADMIN, comprador, destinatario y comprobante.
- W4 web: historial unificado del cliente.
- W5 web: repartidores y ausencias ADMIN.
- W6 web: propuestas y rutas viales en mapa.
- W7 web: retiro y seguimiento de entrega.
- W8 web: emergencia, recuperación y reemplazo ADMIN.

## Log
- L13: Job-17 exit0: 21 asignaciones confirmadas según reparto S6; control final de journal pasó. Backend #35 sigue con MateoAuz y móvil #6–#8 con carlitosgiovanniramos. Títulos, cuerpos, estados y etiquetas sin cambios. Evidencia: odd/issues-replanteamiento-review/assignment-journal.jsonl. No implementación ni pruebas de aplicación.
- L12: «si esta bien. asigna las issue . o que falta para su asignacion». Autorización para aplicar el reparto aceptado, usando sesión Saimol-Uta ya autorizada; no cambiar responsabilidades ajenas ni reescribir cuerpos.
- L11: Ampliación terminada: backend #41–#53 y #35, frontend #32–#39, móvil #8. 23 ediciones verificadas exactas; no cambio de título, estado, asignados o etiquetas. Revisión de ambigüedades, límites y decisiones pendientes; primer control de preparación falló por evidencia omitida, corregida antes de publicar. Control final sin errores ni resultados inciertos y #35 procesada última. Evidencia: odd/issues-replanteamiento-review/{review.md,coverage.json,publication.jsonl}; no pruebas de aplicación, no implementación.
- L10: «realiza esas mejorar en todas las issue». Alcance: 21 nuevas, backend #35 y revisar/ampliar móvil #8 sin duplicar. No publicar documentos locales, no asignar ni cambiar estados/etiquetas. Preparar snapshots/drafts en `odd/issues-replanteamiento-review/`; no tocar código.
- L1: «aa, pense que eran issue, entonces continua con la planificacion»
- L2: «tienes la autorizacion , continua»
- L3: Destinos `github.com/logistica-gc-uta/backend`, `github.com/logistica-gc-uta/frontend-web-logistica`, `github.com/logistica-gc-uta/app-movil-logistica`; integrantes comunicados: carlitosgiovanniramos móvil; kerly1811-mi frontend; MateoAuz backend calidad tester; Saimol-Uta backend líder tester. No asignar automáticamente.
- L4: «si, tienes autorizacion, pero tengo una duda en conversaciones anteriores si sabiar que repositorioas teniamos y los integrantes y sus roles pero ahora se me hace extaseno que me preguntes» — sesión Saimol-Uta confirmada mediante consulta de identidad; issues habilitadas en los tres repositorios.
- L5: Consulta remota completa: backend 17 issues (solo #35 abierta), web 13 (todas cerradas), móvil 8 (3 abiertas); blank issues habilitadas; formulario web E2E no aplica a nuevas features. Móvil #8 abierta cubre fallo/retorno; no crear copia. Issues #13, #31–34 backend verificadas cerradas. Etiquetas protegidas no inferidas.
- L6: Job-4 completó búsquedas específicas de 21 candidatas en abiertas y cerradas, sin saturación. Coincidencias cerradas referencian capacidades anteriores: los cambios nuevos las adaptan y no deben reabrir ni duplicar su alcance. Publicar secuencialmente, detener ante resultado incierto y verificar título/cuerpo en cada lectura.
- L7: Job-5 código 0: backend B1–B13 publicadas y verificadas lectura exacta, respectivamente #41–#53. Ninguna asignación ni etiqueta automática; no repetir.
- L8: Job-6 código 0: frontend W1–W8 publicadas y verificadas lectura exacta, respectivamente #32–#39, con dependencias backend citadas. Móvil #8 permanece abierta, no duplicada.
- L9: Job-8 código 0: #35 backend actualizada con adenda del replanteamiento, dependencias de las nuevas issues y evidencia pendiente; lectura posterior confirmó contenido completo, título y estado OPEN. No se ejecutaron pruebas, no se asignaron responsables ni se añadieron etiquetas.
