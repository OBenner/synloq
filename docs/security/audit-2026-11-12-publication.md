# Pre-publication audit — 2026-11-12

- Status: accepted
- Author: Security
- Scope: S1/S2 из production-plan M1 — скан всей git-истории на секреты + ручной просмотр evidence-документов перед открытием репозитория.
- Метод: gitleaks на машине отсутствует; выполнен эквивалентный скан полного дампа `git log -p --all` (36 610 строк, 46 коммитов, обе ветки) набором регулярных выражений + ручной просмотр совпадений. CI-gate на gitleaks (G3/S4) остаётся обязательным — этот отчёт разовый.

## S1. Скан истории

| Паттерн                                             | Совпадения | Вердикт                                                                                                            |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| base64url 43–44 символа (форма токена Synloq)       | 21         | Все ложные: имена md-файлов и integrity-хэши `pnpm-lock.yaml`. Токенов нет.                                        |
| PEM private key                                     | 0          | Чисто.                                                                                                             |
| Bearer-заголовок со значением                       | 1          | Тестовая константа `Bearer test-only-token` в тесте. Чисто.                                                        |
| password/secret/api_key присваивания                | 3          | Тестовые фикстуры (`stdio-secret-token`, `nested-secret`). Чисто.                                                  |
| token-присваивания длиной ≥ 20                      | 4          | Тестовые фикстуры (`never-print-this-token`, `secret-operator-token-do-not-print`, `must-not-be-accepted`). Чисто. |
| 64-символьный hex (sha256 token hash)               | 0          | Чисто.                                                                                                             |
| Домашние пути (`C:\Users\…`, `/home/…`, `/Users/…`) | 0          | Чисто.                                                                                                             |

Дополнительно: в метаданных коммитов присутствует авторский email оператора — не секрет, но оператору решить, приемлемо ли это для публичной истории (см. production-plan §5).

**Итог S1: история чистая, переписывание не требуется.** Реальных токенов, ключей, credentials-файлов, SQLite и домашних путей в истории нет.

## S2. Evidence-документы (conversationKey / sessionId / UUID / тела сообщений)

Проверены все файлы `docs/superpowers/specs/*`, `test/e2e/*`, `docs/superpowers/plans/*`, `docs/client-compatibility.md`.

| Файл                                                       | Найдено                   | Вердикт                                                                          |
| ---------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| specs/2026-11-09-synloq-design.md                          | ничего                    | чисто                                                                            |
| specs/2026-11-11-codex-adapter-design.md                   | ничего                    | чисто                                                                            |
| specs/2026-11-11-deepseek-web-host-adapter-design.md       | ничего                    | чисто                                                                            |
| specs/2026-11-11-kimi-work-visible-team-design.md          | 1 UUID (пример)           | чисто — иллюстративный идентификатор                                             |
| specs/2026-11-11-kimi-work-live-acceptance.md              | 8 UUID, 2 conversationKey | sanitized: только идентификаторы локального клиента, тел сообщений и токенов нет |
| specs/2026-11-11-synloq-generic-init-acceptance.md         | 5 UUID, 2 conversationKey | sanitized                                                                        |
| specs/2026-11-11-synloq-relay-lifecycle-acceptance.md      | 4 UUID                    | sanitized                                                                        |
| test/e2e/real-clients.md                                   | ничего                    | чисто                                                                            |
| test/e2e/reference.e2e.test.ts                             | ничего                    | чисто                                                                            |
| test/e2e/relay-lifecycle.test.ts                           | ничего                    | чисто                                                                            |
| docs/client-compatibility.md                               | ничего                    | чисто                                                                            |
| plans/2026-11-12-synloq-p1-1-relay-security-enforcement.md | ничего                    | чисто                                                                            |

**Оценка UUID/conversationKey:** это локальные идентификаторы клиентского инстанса оператора (ID чатов и сообщений), не секреты: без доступа к машине оператора они ничего не открывают. Публикация безопасна. Замечание по гигиене: они связывают публичный репозиторий с конкретным инстансом Kimi Work — уровень privacy, не security; оператору на заметку.

**Итог S2:** тела сообщений, токены и секреты в evidence отсутствуют; все файлы пригодны к публикации. Если оператор примет правило §4 плана (исключить `docs/superpowers/` из публичного контура), эти файлы всё равно требуют только опциональной чистки UUID, не обязательной.

## Остаточные действия (не закрываются этим отчётом)

1. CI job gitleaks на PR + GitHub secret scanning/push protection — gates G3/S4, владелец dev.
2. Расширение `.gitignore` (`.synloq/` целиком, `*.token`, `.env*`, `*.log`) — gate G6, владелец dev.
3. Правило в CONTRIBUTING/PR-шаблоне: evidence индексирует только ID участников и сообщений, без тел и токенов.
