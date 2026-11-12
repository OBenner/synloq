# Backlog

Открытая работа после acceptance 2026-11-12. Источники: `docs/security/review-2026-11-12.md` и сводный RESULT CTO (тред bcc7b70f). Приоритеты: P0 — до реализации протокола v1 (закрыто), P1 — следующие, P2 — по мере адаптеров и стабилизации.

## Security и hardening

| #   | Пункт                                                                            | Приоритет | Статус                          |
| --- | -------------------------------------------------------------------------------- | --------- | ------------------------------- |
| H1  | Unauthenticated `/v1/health` до отправки токена                                  | P0        | DONE (56bfeae)                  |
| H2  | Fail-closed loopback-валидация `relayUrl` в MCP-конфиге и `RelayHttpClient`      | P0        | DONE (56bfeae)                  |
| R1  | Взаимная аутентификация relay (per-project challenge) — закрытие residual из R1  | P1        | open                            |
| M1  | `rotate-token` + runbook: перевыпуск не изолирует старые токены (append-only)    | P1        | DONE (b716489, runbook 3454840) |
| M2  | Лимит конкурентных long-poll (per-identity, отказ `RATE_LIMITED`)                | P1        | open                            |
| M4  | Audit log: auth-неудачи, operator-действия, выпуск токенов (append-only, doctor) | P1        | open                            |
| M3  | Retention/GC сообщений синхронно с 7-дневным dedup-TTL из спеки v1               | P2        | open                            |
| —   | Резервирование sender-id `relay`/`operator` в протоколе                          | P2        | open                            |

## UX и обновляемость

| Пункт                                                                                              | Приоритет | Статус |
| -------------------------------------------------------------------------------------------------- | --------- | ------ |
| `doctor --repair`: восстановление конфигов после 401/перевыпуска токенов по сохранённому state     | P1        | open   |
| Убрать абсолютные пути из генерируемых конфигов (перенос репозитория/synloqHome без перегенерации) | P1        | open   |

## Протокол и изоляция

| Пункт                                                                                                                                                                                                                                                                          | Приоритет | Статус |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------ |
| P1.1 per-chat isolation: relay-side связка role-token ↔ bound conversationKey, deny-лог, conformance                                                                                                                                                                           | P1        | open   |
| P1.2 feature request upstream в Kimi Work: per-conversation plugin/MCP scoping                                                                                                                                                                                                 | P1        | open   |
| Спека v1.1: отправитель обязан быть participant (асимметрия `requireParticipant`, инцидент 2026-11-12)                                                                                                                                                                         | P1        | open   |
| Watchdog доставки: алерт/конформанс «stored без visible-доставки > N минут» после рестарта relay (инцидент 2026-11-12)                                                                                                                                                         | P1        | open   |
| Флейк spawn-тестов (`codex-probe`, `supervisor-loop`): падают под нагрузкой в цепочке verify, в изоляции стабильно зелёные — увеличить timeout или retry                                                                                                                       | P1        | open   |
| Runner recovery: `HttpAdapterRunner` не восстанавливается после UNAUTHORIZED на `nextDelivery` (stale generation) — heartbeat без generation маскирует сбой, poll молча в backoff; лечить перерегистрацией + диагностикой (инцидент 2026-11-12, сообщения CTO висели в stored) | P1        | open   |
| P1.3 / P2: адаптеры других хостов (per-role процессы там, где поддерживается)                                                                                                                                                                                                  | P2        | open   |
| L-находки: dead-code `initCommand`, lock на credentials.json, fsync, сводка spec↔impl (hops, NOTICE оператору, strict zod)                                                                                                                                                     | P2        | open   |

## Правила работы с backlog

- Пункт закрывается коммитом со ссылкой на строку этой таблицы; статус меняется в том же коммите.
- Новые находки из ревью добавляет роль, сделавшая ревью, с приоритетом и источником.
