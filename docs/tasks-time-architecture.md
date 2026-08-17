# Tareas y gestión del tiempo

## Modelo

Una tarea es la única fuente de verdad. Al llevarla a la agenda se escriben
`scheduled_date` y `scheduled_time` en la misma fila; no se crea una copia.
Los compromisos sin tarea viven en `agenda_events`. Las eliminaciones desde la
interfaz son archivados lógicos para preservar el historial.

Las duraciones se expresan en minutos, en pasos de 30, con un rango recomendado
de 30 a 240 minutos. `actual_duration_min` y los campos de temporizador permiten
comparar estimación y tiempo real. `reschedule_count` alimenta las estadísticas.

Las preferencias no sensibles pueden guardarse por perfil en `suite_data`.

## Sugerencias

El planificador es deliberadamente explicable: puntúa primero la matriz de
Eisenhower, después la cercanía de la fecha límite y finalmente busca un hueco
que acepte la duración completa. Propone como máximo tres tareas y nunca mueve
datos sin confirmación del usuario.

## Recurrencia

Al completar una tarea recurrente se genera su siguiente ocurrencia como una
tarea nueva enlazada por `recurrence_parent_id`, conservando el historial. Los
compromisos recurrentes admiten cambios en una fecha, en esa fecha y futuras, o
en toda la serie; las excepciones se guardan en `recurrence_exceptions`.

## Notificaciones

La versión actual muestra avisos del navegador cuando la PWA está abierta. Las
notificaciones push con la app cerrada requieren suscripción Web Push y una
función protegida en servidor; no se simulan desde código cliente.
