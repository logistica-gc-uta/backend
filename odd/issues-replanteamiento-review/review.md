# Revisión de los cuerpos ampliados

Alcance: 21 issues nuevas, QA backend #35 y móvil #8 existente. Solo cuerpo; conservar título, estado, etiquetas y asignados. Sin publicación de documentos locales ni ejecución de aplicación.

## Evidencia previa a publicar

- Snapshot de 23 versiones actuales en `current.json`; identidad y repositorios autorizados verificados.
- Explorador `mwb883r7-h-voy0`: referencias backend y límites de observación verificados.
- Explorador `mwb8i1j9-i-ueyf`: leyó los 23 borradores y comparó criterios anteriores.
- Primer control de conservación detectó una línea genérica de evidencia omitida; restaurada antes de publicar.
- Revisión semántica corrigió retiro rechazado sin cancelación automática de alternativas, granularidad de recuperación/reserva, reemplazo pendiente sin stock/acuerdo, disponibilidad efectiva tras retorno, dependencia de configuración de OSRM, seguimiento externo de invitados y semántica de margen pendiente.
- Se separaron prerrequisitos de integración de coordinación para evitar cierres recíprocos como condición de trabajo.
- Observación del revisor sobre correcciones de contacto no aprobadas: no se aplicó, porque el usuario sí aprobó conservar historial de correcciones; consta en Engram 2645 y conversación. No añadir auditoría nueva más allá de esa decisión.
- En QA se aclara un criterio anterior: semántica de margen acordada/documentada antes de implementar, no elegida unilateralmente por el código. Los otros criterios anteriores se conservaron textualmente; ninguna prueba se marca realizada.
- Validación local: 23 cuerpos en alcance, privacidad básica sin coincidencias, títulos/URLs/versiones correspondientes al snapshot, 29 grupos NR trazados y 41 checkboxes QA preservados.

## Límites

Los cuerpos son handoffs con reglas y ejemplos, no afirmaciones de funcionamiento. Permanecen abiertas decisiones de contratos, margen exacto, estados y reservas, provisión de credenciales e infraestructura. La auditoría es acotada; no acredita ausencia global de funciones ni seguridad integral. Publicación pendiente de lectura exacta tras cada edición y comprobación de metadata.
