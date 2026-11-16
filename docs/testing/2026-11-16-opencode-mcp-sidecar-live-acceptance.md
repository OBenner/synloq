# Acceptance: OpenCode MCP sidecar live-окно (#67 / #80)

Дата: 2026-11-16. Участники: оператор, dev (Kimi), tester (OpenCode Desktop 2.2.7).
Код: main `06f1dd7` (включает #80). Чеклист: `docs/testing/opencode-mcp-sidecar.md`.
Evidence: audit `~/.synloq/data/c2d367a43fc8a638-audit.jsonl`, лог OpenCode
`~/.local/share/opencode/log/opencode.log`. Credentials и тела сообщений не включены.

## Результаты по шагам чеклиста

| Шаг | Сценарий                               | Вердикт | Evidence                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3   | Автозапуск sidecar в MCP child         | PASS    | 11:16:58Z registerSession tester accept, generation 2, surface `opencode-mcp`                                                                                                                                                                                                                                      |
| 4   | Idle wake через MCP sidecar            | PASS    | маркер W3A доставлен и ackнут за ~15 с, claim_generation 2                                                                                                                                                                                                                                                         |
| 5   | Busy/FIFO, фильтрация дубля            | PASS    | пара W3B-1/W3B-2 обработана FIFO одним turn; повторная инъекция того же ID отфильтрована                                                                                                                                                                                                                           |
| 6   | Рестарт relay                          | PASS    | generation сохранена (2), перерегистрации нет, маркер W3C ackнут после рестарта                                                                                                                                                                                                                                    |
| 7   | Takeover ручным sidecarом              | PASS    | 11:30:12Z manual register accept gen 3 (surface `opencode`); MCP child зафиксировал потерю ownership и остановил sidecar-контур: `delivery ownership lost; sidecar stopped ... no automatic takeover` (stderr child, opencode.log 11:35:12Z). Доставка W3D через gen 3                                             |
| 8   | Рестарт MCP при живом lease            | PASS    | 11:54:37Z registerSession tester **deny** «a delivery owner has an unexpired lease; use explicit replace-session for takeover» (surface `opencode-mcp`). Sidecar-контур child не запущен, MCP-инструменты (6 шт.) доступны, доставка маркера W3E через ручной sidecar gen 6 (claim_generation 6), ack/reply штатно |
| 9   | Expiry lease → rebind → восстановление | PASS    | остановка ручного sidecar, истечение lease, перезапуск child: 11:58:41Z accept gen 7 surface `opencode-mcp`; маркер W3F ackнут с claim_generation 7                                                                                                                                                                |
| 10  | Shutdown без сирот                     | PASS    | при смерти backend-сервиса OpenCode child умирает вместе с ним, сиротских node-процессов нет, heartbeat прекращается                                                                                                                                                                                               |

## Дополнительные наблюдения (хост-специфика OpenCode Desktop)

1. **Backend-сервис отделён от GUI.** `opencode-cli serve --service` переживает
   закрытие и перезапуск окна приложения; MCP-подключения привязаны к backend,
   а не к GUI. Перезапуск окна не переподключает MCP.
2. **Нет retry упавшего MCP.** Если child умер (kill), backend снимает namespace
   роли и не переподключается ни при фокусе сессии, ни при вводе — только при
   перезапуске backend (проектное «location services booted»).
3. **Fail-closed при гонке быстрого респауна.** GUI переподнял backend через
   ~7 с после kill; новый child упрётся в неистёкший lease предыдущего (gen 7) и
   получил deny (12:10:23Z). Автоматических повторов нет — восстановление
   потребовало ещё одного перезапуска backend после истечения lease (~15 с),
   что соответствует задокументированному ограничению PR #80.
4. **Разовая пара `invalid project credential` (11:17:32Z и далее при каждом
   перезапуске backend)** — соседние проекты оператора (`open-code-synloq`),
   чьи MCP-конфиги указывают на credentials чужого проекта. К окну отношения
   не имеет; полезный сигнал: deny логируется без утечки деталей.

## Ограничения

- Проверялся один хост (OpenCode Desktop 2.2.7, Windows), одна роль (tester).
- Шаг 10 проверен по hostile-пути (kill backend); graceful quit отдельно не
  воспроизводился из-за п.1–2 (GUI не завершает backend штатно).
- Wake при busy, steering-дубли — покрыты в шаге 5 базово, без нагрузочного контура.

## Итог

Live automatic lifecycle (#80) подтверждён end-to-end: автозапуск, wake,
FIFO/dedup, relay-restart resilience, takeover semantics (обе стороны),
DUPLICATE_SESSION fail-closed, expiry-rebind recovery, чистый shutdown.
Issue #67 может быть закрыт после фиксации этой записи.
