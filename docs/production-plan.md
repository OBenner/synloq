# Synloq — Production-Readiness Plan

- Status: draft → accepted (после утверждения оператором)
- Date: 2026-11-12
- Authors: CTO (свод), Architect (архитектура/GitHub), Security (security gates)
- Sources: arch thread b7d31611, security thread 4a9813e9, consolidated review thread bcc7b70f

## 0. Текущее состояние

- Ветка `feat/synloq-mvp`, HEAD `c82f5e5`; `pnpm verify` зелёный: 51 файл / 451 тест.
- Спека протокола v1 принята (`docs/protocol/v1.md`); разрывы спека↔код зафиксированы в §9 спеки.
- H1/H2 закрыты (`56bfeae`): health-маркер до отправки токена; fail-closed loopback-валидация во всех путях.
- Команда: 4 роли (cto, arch, security, dev), координация через relay подтверждена live.

## 1. Целевые вехи

| Веха                       | Содержание                                    | Оценка                 |
| -------------------------- | --------------------------------------------- | ---------------------- |
| **M1. Public alpha (0.x)** | GitHub-гейты G1–G8 + security must-haves      | **3–5 рабочих дней**   |
| **M2. v1.0 production**    | Все пункты A–E + P1.1 + security полный скоуп | **10–14 рабочих дней** |

Стратегия: открываемся как public alpha сразу после гейтов M1, не дожидаясь v1.0 — ранняя публикация дешевле поздней чистки истории.

## 2. GitHub-гейты (M1, must-have)

| #   | Пункт                                                                                                                                                                                                                         | Владелец     | Оценка |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ |
| G1  | LICENSE (Apache-2.0 или MIT — **решение оператора**) + NOTICE; поправить `license: "UNKNOWN"` в kimi.plugin.json                                                                                                              | cto/dev      | 0.5 д  |
| G2  | Аудит git-истории (46 коммитов): gitleaks по всей истории, ручной просмотр docs/superpowers/specs и test/e2e на conversationKey/sessionId/UUID. Предварительная проверка security: история чистая, переписывание не требуется | security     | 1 д    |
| G3  | CI: GitHub Actions — `pnpm verify` на push/PR, матрица Node LTS, `--frozen-lockfile`, `pnpm audit`, gitleaks job                                                                                                              | dev          | 1 д    |
| G4  | Branch protection main: CI green обязателен, 1 approve, no force-push, linear history                                                                                                                                         | оператор/cto | 0.5 д  |
| G5  | Шаблоны: `.github/ISSUE_TEMPLATE`, `PULL_REQUEST_TEMPLATE` (чеклист: docs обновлены? тесты? протокол затронут?)                                                                                                               | dev          | 0.5 д  |
| G6  | `.gitignore`: `.synloq/` целиком, `*.token`, `.env*`, `*.log`                                                                                                                                                                 | dev          | 0.1 д  |
| G7  | `CONTRIBUTING.md` (verify, conventional commits, без DCO/CLA)                                                                                                                                                                 | cto          | 0.5 д  |
| G8  | README публичного качества: quickstart install→init→роли, known limitations (R1, рестарт relay после смены synloq.yaml)                                                                                                       | dev          | 1 д    |

### Security must-haves для M1 (блокируют публикацию)

| #    | Пункт                                                                                                                                                                       | Оценка    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| S-G1 | **rotate-token + revoke** (команда + runbook) — без ротации любая утечка = пересоздание проекта                                                                             | 2 д       |
| S-G2 | Удалить dead-code initCommand, возвращающий plaintext-токены (L1)                                                                                                           | 0.5 д     |
| S-G3 | Свести spec↔impl: hops 4 vs «8» в инструкциях ролей; канал эскалации оператору (operator не participant — NOTICE невозможен); forward-compat (strict zod vs ignore unknown) | 1.5 д     |
| S-G4 | R1 (подделываемый health-маркер) как known limitation в README + threat model                                                                                               | (в G8/D2) |
| S-G5 | `docs/security/threat-model.md` (публичная версия)                                                                                                                          | 0.5 д     |
| S-G6 | `SECURITY.md`: responsible disclosure, supported versions, scope модели угроз                                                                                               | 0.5 д     |
| S-G7 | Supply chain: frozen-lockfile в CI, Dependabot, engines baseline (Node 24+)                                                                                                 | (в G3)    |
| S-G8 | `docs/security/token-rotation.md`: runbook rotate/revoke, диагностика 401                                                                                                   | 0.5 д     |

**Post-release (допустимо отложить):** M2 (лимит long-poll), M3 (retention/GC), расширенный audit log, SBOM/подпись релизов/SLSA.
**Исключение:** M4-min (минимальный audit: auth failures + operator actions + credential issue/rotate) — **до релиза**, т.к. runbook ротации без аудита слеп (1.5 д).

## 3. Дорожная карта v1.0 (M2)

### A. Протокол/API

- A1. Реализация спеки v1: поля `version/type/hops/reasonCode` в домене и store — 3–4 д.
- A2. Спека v1.1 (requireParticipant проверяет и отправителя; резервирование sender-id `relay`/`operator`) + реализация — 1–2 д.
- A3. Conformance-suite протокола как отдельный набор — 1 д.
- A4. Политика совместимости (minor = расширение, major = новая version) в спеке — 0.5 д.

### B. Миграции state/credentials

- B1. version-поле в state/credentials (по образцу `.synloq-owner.json`), forward-only, fail-loud — 1–2 д.
- B2. Правило + первый образец теста «старый state → новый бинарь» — 0.5 д.

### C. Observability

- C1. P1.1: relay-side enforcement (role-token ↔ conversationKey), deny-audit JSONL, conformance-тесты, threat model — 2–3 д (план: docs/superpowers/plans/2026-11-12-synloq-p1-1-relay-security-enforcement.md).
- C2. Метрики: счётчики accepted/denied/delivered, состояние supervisor-loop, версия протокола в health — 1–2 д.
- C3. Runbook по audit-логу и диагностике delivery_uncertain — 0.5 д.

### D. Упаковка/дистрибуция

- D1. Один артефакт: install → init → роли без ручных правок; идемпотентный init для 4+ ролей — 2–3 д (наименее предсказуемый пункт).
- D2. Semver релизов; регенерация плагина сохраняет projectKey (digest-стабильность) — 0.5–1 д.
- D3. Тест upgrade path: обновление плагина не ломает runtime-конфиги и чаты — 1 д.

### E. Хосты

- E1. Хост-контракт документом (capabilities, session lifecycle, delivery receipt) — 1 д.
- E2. Kimi Work — production; остальные хосты — beta/post-1.0 (решение CTO: **принято, P2**).

## 4. Governance документации (действует с момента принятия плана)

**Обязательный набор:** README.md (корень), docs/protocol/v1.md, CHANGELOG.md (Keep-a-Changelog), docs/adr/ (Status/Context/Decision/Consequences), docs/runbooks/, docs/security/threat-model.md, SECURITY.md.

**Правила:**

1. Документация обновляется в том же коммите, что и код; PR без обновления затронутых docs не мёржится (пункт в ревью-чеклисте PR-шаблона).
2. Владение: спека протокола — CTO + Architect (двойной approve); runbooks — владелец подсистемы; README/CHANGELOG — CTO; security-документы — Security.
3. Документы версионируются git'ом; отдельно версионируется только протокол (поле `version`). Каждый документ несёт дату и статус (draft/accepted/superseded).
4. Служебные материалы (docs/superpowers/plans, research) — не в публичном контуре или переносятся в docs/design с чисткой.
5. Изменения спеки — только через PR с указанием версии протокола.

## 5. Открытые решения (оператор)

1. **Лицензия: MIT или Apache-2.0** (рекомендация CTO: Apache-2.0 — патентная защита при той же пермиссивности).
2. Публикация `docs/superpowers/` — исключить или чистить.
3. Имя/организация репозитория на GitHub.

## 6. Риски и ограничения оценок

- Темп команды оценён по последним 2 дням; D1 (init-UX) — наименее предсказуемый пункт.
- Multi-user машины: residual R1 остаётся (known limitation, взаимная аутентификация relay — в backlog).
- Все оценки в person-days; параллельность dev+arch+security уже учтена в диапазонах вех.
