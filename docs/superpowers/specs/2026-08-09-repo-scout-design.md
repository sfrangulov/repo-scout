# repo-scout — дизайн

Дата: 2026-08-09. Статус: draft (прошёл панель ревью, ожидает ревью пользователя).

## Цель

Личный инструмент: находит недавно активные малозаметные GitHub-репозитории
по темам интересов, оценивает их локальным вызовом `claude -p`, показывает
кандидатов в интерактивном CLI — а решение «star / follow / мимо» принимает
человек. Никаких автоматических социальных действий: это осознанное отличие
от прототипа-вдохновителя (yumiaura/followme), который лайкает и подписывается
сам и тем нарушает GitHub Acceptable Use Policies.

Код followme не переиспользуется (у него нет лицензии); реализация — с нуля.

## Стек

- TypeScript на Node.js ≥ 24, запуск напрямую (`node src/scan.ts`,
  нативный type stripping — без build-шага и без tsx).
  Ограничение type stripping: только «стираемый» синтаксис — без `enum`,
  `namespace`, parameter properties.
- Пакетный менеджер — pnpm. Рантайм-зависимостей ноль; dev-зависимости
  только `typescript` + `@types/node` (для `tsc --noEmit`).
- Состояние — `node:sqlite` (модуль формально experimental; warning
  подавляется флагом `--no-warnings` в npm-скриптах).
- Тесты — встроенный `node:test`.
- Флаги CLI — `util.parseArgs`; интерактив — `readline` + raw stdin.
- Внешние процессы: `git` (shallow clone), `gh` (GitHub API через keyring —
  токенов в конфиге нет), `claude` (оценка через подписку Claude Code),
  `open` (macOS, открытие ссылки в браузере).

## Структура

```
repo-scout/
├── package.json          # pnpm; "engines": {"node": ">=24"};
│                         # scripts: scan, review, test, typecheck
├── tsconfig.json         # noEmit, strict
├── .gitignore            # data/, node_modules/
├── config.ts             # пользовательский конфиг (типизированный модуль)
├── src/
│   ├── scan.ts           # entry: поиск + оценка
│   ├── review.ts         # entry: интерактивное ревью
│   └── lib/
│       ├── types.ts      # Config и другие общие типы
│       ├── db.ts         # node:sqlite: схема + запросы
│       ├── gh.ts         # обёртки gh api (search, star, follow)
│       ├── clone.ts      # shallow clone во временный каталог
│       ├── digest.ts     # дайджест: список путей + снипеты (+ константы лимитов)
│       └── evaluate.ts   # вызов claude -p + парсинг ответа
├── test/                 # *.test.ts (node:test)
├── docs/superpowers/specs/
└── data/                 # gitignored: scout.sqlite (каталог создаёт db.ts)
```

Пути (`dbPath`) резолвятся от корня проекта (по `import.meta.url`),
не от cwd.

## Конфиг (`config.ts`)

Типизированный модуль, правится руками, парсер не нужен. Только ручки,
которые реально крутят:

```ts
import type { Config } from "./src/lib/types.ts";

export default {
  queries: [
    "topic:mcp",
    "topic:claude-code",
    '"claude code" in:name,description',
    "topic:llm-agents",
    "topic:ai-agents language:typescript",
    "topic:rag language:typescript",
  ],
  maxStars: 200,        // добавляется к каждому запросу как stars:<N
  perQuery: 10,         // максимум новых кандидатов с одного запроса за scan
  reviewThreshold: 12,  // минимальный idea+skill для показа в review
  model: "haiku",       // передаётся в claude -p --model
  dbPath: "data/scout.sqlite",
} satisfies Config;
```

Стартовые запросы — интересы из research-репо (MCP, Claude Code тулинг,
LLM-агенты, RAG); список правится свободно.

Лимиты дайджеста — константы в `digest.ts` (не конфиг): `MAX_FILES = 20`,
`MAX_LINES_PER_FILE = 80`, `MAX_CHARS_PER_FILE = 4_000`,
`MAX_TOTAL_CHARS = 40_000`, `MAX_FILE_BYTES = 262_144`; расширения
`.ts .tsx .js .jsx .py .go .rs .md .yaml .yml .toml .sh .sql`; игнор-каталоги
`.git node_modules dist build out vendor target __pycache__ .venv venv
.next .idea .vscode`.

## Схема БД

Одна таблица `entries`, одна строка на репозиторий. URL и логин владельца
не хранятся — выводятся из PK: `html_url = https://github.com/{repo}`,
`clone_url = html_url + ".git"`, `profile = repo` до `/`.

```sql
CREATE TABLE IF NOT EXISTS entries (
  repo            TEXT PRIMARY KEY,      -- owner/name
  owner_type      TEXT NOT NULL,         -- 'User' | 'Organization' (из search payload)
  query           TEXT NOT NULL,         -- каким запросом найден
  found_at        TEXT NOT NULL,         -- UTC ISO-8601
  evaluated_at    TEXT,
  idea            REAL,                  -- 1.0–10.0
  skill           REAL,                  -- 1.0–10.0
  description     TEXT,                  -- одно предложение от модели
  security_flag   INTEGER NOT NULL DEFAULT 0,
  security_reason TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'new',  -- new | evaluated | reviewed | failed
  fail_count      INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  followed        INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TEXT                   -- UTC ISO-8601, ставится при status='reviewed'
);
```

Жизненный цикл строки: `new` (найден) → `evaluated` (оценён) → `reviewed`
(человек решил, `reviewed_at` заполнен). Ветка `failed` — терминальная для
стабильно неоценимых (см. «Обработка ошибок»). Оценённые ниже порога
остаются `evaluated` — история, доступны через `review --min-score`.

## Команда `scan`

`pnpm scan` (= `node --no-warnings src/scan.ts`):

1. По каждому запросу из `config.queries`:
   `gh api -X GET /search/repositories -f q="${query} stars:<${maxStars}"
   -f sort=updated -f order=desc -F per_page=100`, одна страница.
   `-X GET` обязателен: с `-f`-параметрами gh иначе молча переключается на
   POST, а `POST /search/repositories` не существует → 404.
   Из результатов берутся первые `perQuery` репозиториев, которых ещё нет
   в БД (проверка по PK), вставка со статусом `new` + `owner_type` из
   `owner.type`. Лимит GitHub Search — 30 запросов/мин с токеном;
   6 запросов по одной странице — с запасом.
2. Для каждой строки `status='new'` (с построчным прогрессом
   `[i/N] owner/repo → idea X skill Y` либо причиной пропуска):
   shallow clone (`git clone --depth 1 --quiet`, таймаут 180 с) во
   временный каталог внутри `os.tmpdir()`, каталог удаляется в `finally`.
3. Дайджест: плоский список путей (фильтр по расширениям, игнор-каталоги,
   лимиты — константы `digest.ts`) + снипеты первых `MAX_LINES_PER_FILE`
   строк каждого файла, суммарно ≤ `MAX_TOTAL_CHARS`. Порядок отбора
   детерминирован: README* первым, дальше пути по алфавиту; первые
   `MAX_FILES`. Пустой дайджест (ни одного подходящего файла) — оценка
   пропускается: warning + фейл-ветка, `claude` с пустым вводом не зовётся.
4. Оценка: один вызов `claude -p <prompt> --model <model>` (таймаут 180 с).
   Промпт — инструкция + дайджест, требует строгий JSON:
   `{idea, skill, description, security_flag, security_reason}`.
   Шкала с якорями (1 = trivial, 5 = ordinary, 9 = strong) и
   malicious-скрин из followme (харвестинг секретов, exfiltration,
   обфусцированный exec, C2, тайпсквоттинг; «опрятность кода не снижает
   подозрение»). Флагнутые репозитории сохраняют реальные оценки модели —
   `security_flag` не занижает `idea`/`skill`. Ответ парсится: первый
   `{...}`-блоб, `clamp` оценок в [1, 10], коэрция `security_flag` из
   true/"true"/1.
5. Успех → `UPDATE`: оценки, `status='evaluated'`, `evaluated_at`.
   Фейл (клон, пустой дайджест, оценка) → warning + `fail_count += 1`;
   при `fail_count >= 3` — `status='failed'`; git-ошибка
   «repository not found» (репо удалён/приватизирован) → `failed` сразу.
   Иначе строка остаётся `new` и повторится в следующем scan.
6. Сводка: added / evaluated / failed / pending-review.

Замечание о «свежести»: `sort=updated` даёт недавно активные репозитории
(в том числе старые с недавним пушем) — это осознанный выбор, фильтра по
дате создания нет.

## Команда `review`

`pnpm review` (= `node --no-warnings src/review.ts [--min-score N]`):

Выборка: `status='evaluated' AND (idea+skill >= threshold OR security_flag=1)` —
флагнутые репозитории попадают в очередь всегда, независимо от порога.
Сортировка — сначала без security-флага, внутри по убыванию суммы; флагнутые
идут последними, с предупреждением. Флаг `--min-score` перекрывает
`config.reviewThreshold`.

Пустая очередь — не ошибка: печатается сводка «очередь пуста: N оценено
ниже порога (попробуй --min-score), M ждут оценки (запусти scan)»,
выход с кодом 0.

Экран кандидата:

```
[3/7] tinyorm/pico-db   idea 8.2  skill 7.5  sum 15.7   (query: topic:llm-agents)
  «Однофайловый ORM на dataclasses, ноль зависимостей»
  https://github.com/tinyorm/pico-db

  [s]tar  [f]ollow  [b]oth  [o]pen  [n]ext  [q]uit
```

Кандидат с `security_flag` дополнительно показывает строку
`⚠ SECURITY: <reason>` — решение всё равно за человеком.
Для `owner_type = 'Organization'` клавиши `[f]`/`[b]` не предлагаются
(REST API умеет фолловить только пользователей); в подсказке остаются
`[s]tar [o]pen [n]ext [q]uit`.

Клавиши (raw keypress, без Enter). В командах gh значения подставляются
интерполяцией из БД — литеральные `{...}` в endpoint нельзя: gh резервирует
`{owner}`/`{repo}`/`{branch}` под собственные плейсхолдеры из cwd:

- `s` — `gh api -X PUT "user/starred/${entry.repo}"` → `starred=1`,
  `status='reviewed'`, `reviewed_at`, следующий кандидат.
- `f` — `gh api -X PUT "user/following/${profile}"` → `followed=1`,
  `status='reviewed'`, `reviewed_at`, следующий. При HTTP 403 — подсказка:
  `gh auth refresh -h github.com -s user:follow` (разово добавить скоуп).
- `b` — star, затем follow. Каждое успешное действие фиксируется в БД
  сразу; если второе упало — warning, статус не меняется, остаёмся на
  кандидате (повтор `b` безопасен: PUT идемпотентен, уже успешная половина
  просто подтвердится).
- `o` — `open <html_url>`; остаёмся на кандидате (посмотреть и решить).
- `n` — `status='reviewed'`, `reviewed_at`, без действий (больше не
  покажется), следующий.
- `q` — выход; непросмотренные остаются в очереди.

Действия идемпотентны: PUT уже поставленной звезды / повторный follow — no-op
на стороне GitHub (204), в БД просто фиксируется флаг.

## Обработка ошибок

- Фейлы scan — см. шаг 5: до трёх попыток между запусками, затем `failed`;
  «repository not found» — `failed` сразу.
- Фейл `gh api` в review: warning с телом ошибки, статус строки не меняется,
  остаёмся на кандидате.
- `gh`/`claude` не установлены или не залогинены — понятная ошибка на старте
  (проверка `gh auth status` и наличия бинарей перед работой).

## Тесты (`node:test`)

Чистая логика тестируется без сети; subprocess-вызовы (`gh`, `git`,
`claude`) идут через тонкие функции-обёртки, которые в тестах подменяются:

- `evaluate`: парсинг JSON-блоба (валидный, с прозой вокруг, кривой,
  clamp за границами, коэрция security_flag).
- `digest`: сборка на fixture-каталоге (лимиты файлов/строк/символов,
  README первым, игнор-каталоги, фильтр расширений, пустой результат).
- `db`: in-memory sqlite — переходы new→evaluated→reviewed/failed,
  fail_count, идемпотентность вставки, выборка очереди ревью (порог,
  сортировка, security-последние), вывод html_url/profile из PK.

## Чего сознательно нет (YAGNI)

- Демона/бесконечного цикла — `scan` запускается руками (cron — потом,
  если захочется).
- HTML/TUI-интерфейсов, метрик, дашбордов.
- Авто-действий по порогу — принципиально: только человек решает.
- Конфига моделей per-query, многостраничного поиска, ретраев с backoff
  внутри одного scan, тюнинга лимитов дайджеста через конфиг.
