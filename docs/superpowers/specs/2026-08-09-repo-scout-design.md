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
    "topic:claude-code-plugin",
    "topic:model-context-protocol",
    "topic:rag language:typescript",
    "topic:agent-observability",
    "topic:tmux topic:ai",
  ],
  minStars: 2,             // добавляется к каждому запросу как stars:<N>..<M>, отсекает спам-репо
  maxStars: 200,
  perQuery: 10,             // максимум новых кандидатов с одного запроса за scan
  interestThreshold: 6,     // минимальный interest (личная ось) для показа в review
  minSkill: 4,              // минимальный skill для показа в review
  model: "haiku",           // передаётся в claude -p --model
  dbPath: "data/scout.sqlite",
} satisfies Config;
```

Стартовые запросы — интересы из research-репо (MCP, Claude Code тулинг и
плагины, MCP-протокол, RAG, agent observability, tmux+AI); список правится
свободно.

`minStars` — нижний пол по звёздам в самом поисковом запросе (не постфильтр):
отсекает депозитории-спам и пустые форки до того, как они попадут в БД и
будут стоить оценки моделью.

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
  interest        REAL,                  -- 1.0–10.0, личная ось (см. evaluate.ts)
  interest_reason TEXT NOT NULL DEFAULT '', -- одно предложение — почему такой interest
  description     TEXT,                  -- одно предложение от модели
  security_flag   INTEGER NOT NULL DEFAULT 0,
  security_reason TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'new',  -- new | evaluated | reviewed | failed
  fail_count      INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  followed        INTEGER NOT NULL DEFAULT 0,
  reviewed_at     TEXT,                  -- UTC ISO-8601, ставится при status='reviewed'
  author_followers    INTEGER,           -- author signal, best-effort (см. ниже)
  author_public_repos INTEGER,
  author_created_at   TEXT,
  repo_stars      INTEGER,               -- из search-результата, на момент находки
  repo_forks      INTEGER,
  repo_pushed_at  TEXT,
  repo_license    TEXT,                  -- spdx_id, с фолбэком на license.key
  repo_language   TEXT
);
```

`interest`/`interest_reason`, а затем author-signal-колонки появились после
первой версии; `openDb` держит guarded-миграцию (`PRAGMA table_info` →
`ALTER TABLE ... ADD COLUMN`) для уже существующих файлов БД —
`CREATE TABLE IF NOT EXISTS` их не добавит.

### Author signal (display-only)

Эмпирика на живых данных (n=11 старов пользователя): `followers` и
`public_repos` автора чисто разделяют его стары (2-29 followers, 7-41 repos)
от junk/malware-аккаунтов (0-1 followers, 1-4 repos) из прошлых сканов;
возраст аккаунта не разделяет. Сигнал — **только отображение и флаг
внимания**, никогда не авто-reject и никогда не причина пропустить
clone/evaluate: у пользователя интересов больше, чем у среднего джанк-автора,
но встречаются и настоящие новички с полезным репо — решение остаётся за
человеком в `review`.

`repo_stars`/`repo_forks`/`repo_pushed_at`/`repo_license`/`repo_language`
берутся из search-payload и пишутся при `insertNew` (на момент находки,
не обновляются задним числом). `author_*` — отдельный `gh api GET
users/<login>` сразу после успешной вставки нового кандидата (не для уже
известных репо), best-effort: неудача лукапа не блокирует scan, поля
остаются NULL.

`isThinAuthor(entry)` (в `db.ts`) — чистая функция: `true`, когда
`authorFollowers <= 1 && authorPublicRepos <= 5` (обе метрики не NULL).
Пороги — из n=11 выборки, только для UI-подсказки в `review`.

Жизненный цикл строки: `new` (найден) → `evaluated` (оценён) → `reviewed`
(человек решил, `reviewed_at` заполнен). Ветка `failed` — терминальная для
стабильно неоценимых (см. «Обработка ошибок»). Оценённые ниже порога
остаются `evaluated` — история, доступны через `review --min-interest`.

## Команда `scan`

`pnpm scan` (= `node --no-warnings src/scan.ts`):

1. По каждому запросу из `config.queries`:
   `gh api -X GET /search/repositories
   -f q="${query} stars:${minStars}..${maxStars} fork:false archived:false"
   -f sort=updated -f order=desc -F per_page=100`, одна страница.
   `-X GET` обязателен: с `-f`-параметрами gh иначе молча переключается на
   POST, а `POST /search/repositories` не существует → 404. Пол по звёздам
   (`minStars`) и фильтры `fork:false archived:false` отсекают форки,
   архивные и совсем пустые репозитории уже на уровне запроса — до того,
   как они попадут в БД и будут стоить оценки моделью.
   Из результатов пропускаются архивные и template-репозитории (проверка
   `archived`/`is_template` на уровне payload — belt-and-braces поверх
   фильтров запроса) и берутся первые `perQuery` репозиториев, которых ещё
   нет в БД (проверка по PK), вставка со статусом `new` + `owner_type` из
   `owner.type` + метаданные репо (`stars`, `forks`, `pushed_at`, `license`,
   `language`) из того же search-результата. Сразу после успешной вставки —
   `gh api GET users/<login>` за author signal (см. «Author signal» выше);
   для уже известных репозиториев лукап не повторяется. Лимит GitHub
   Search — 30 запросов/мин с токеном; 8 запросов по одной странице — с
   запасом.
2. Для каждой строки `status='new'` (с построчным прогрессом
   `[i/N] owner/repo → idea X skill Y interest Z` либо причиной пропуска):
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
   `{idea, skill, interest, interest_reason, description, security_flag, security_reason}`.
   Шкала с якорями (1 = trivial, 5 = ordinary, 9 = strong), калибровка
   против кластеризации в 6-8 (напоминание, что digest — уже
   предфильтрованная подборка, а не случайная выборка GitHub, поэтому
   бо́льшая часть должна всё равно ложиться в 4-6) и запрет поднимать
   оценку за манифест/заявленный бенчмарк без видимого в дайджесте кода.
   `interest` оценивает соответствие личному профилю интересов пользователя
   (harness-тулинг для coding-агентов, agent observability, verified
   knowledge/memory, local-first инструменты — подробный профиль интересов
   в `evaluate.ts`, HIGH/MEDIUM/LOW с явными примерами и исключением для
   «скучной категории» с реальным механизмом). `idea`/`skill` остаются
   универсальной инженерной оценкой, независимой от личных интересов.
   Malicious-скрин из followme (харвестинг секретов, exfiltration,
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
6. Сводка: added / evaluated / failed / pending-review, плюс гистограмма
   `interest` только по репозиториям, оценённым за этот прогон
   (`1-4: N  5-7: M  8-10: K`) — сигнал, не сместилась ли модель в
   кластеризацию до следующего ручного ревью промпта.

Замечание о «свежести»: `sort=updated` даёт недавно активные репозитории
(в том числе старые с недавним пушем) — это осознанный выбор, фильтра по
дате создания нет.

## Команда `review`

`pnpm review` (= `node --no-warnings src/review.ts [--min-interest N]`):

Выборка: `status='evaluated' AND (security_flag=1 OR (interest >= minInterest
AND skill >= minSkill))` — личный `interest` первичен, `idea` в отбор не
участвует (входит только в сортировку как второй тай-брейк). Флагнутые
репозитории попадают в очередь всегда, независимо от порога. Сортировка —
сначала без security-флага, внутри по убыванию `interest`, при равенстве —
по убыванию `idea+skill`; флагнутые идут последними, с предупреждением.
Флаг `--min-interest` перекрывает `config.interestThreshold`; порог по
skill (`config.minSkill`) фиксирован конфигом, отдельного флага под него нет.

Пустая очередь — не ошибка: печатается сводка «очередь пуста: N оценено
ниже порога (попробуй --min-interest), M ждут оценки (запусти scan)»,
выход с кодом 0.

Экран кандидата:

```
[3/7] tinyorm/pico-db   interest 8.7  idea 8.2  skill 7.5   (query: topic:agent-observability)
  «Однофайловый ORM на dataclasses, ноль зависимостей»
  why: local-first SQLite CLI с committed embeddings, без SaaS-зависимости
  https://github.com/tinyorm/pico-db
  ★12 · 3 forks · MIT · TypeScript · pushed 2026-08-05 · author: 15 followers / 22 repos

  [s]tar  [f]ollow  [b]oth  [o]pen  [n]ext  [q]uit
```

Строка `why:` печатается только когда `interest_reason` непусто — одно
предложение модели про конкретный механизм, который сыграл на interest.
Кандидат с `security_flag` дополнительно показывает строку
`SECURITY WARNING: <reason>` — решение всё равно за человеком. Тонкий
автор (`isThinAuthor`, см. «Author signal») показывает рядом строку
`THIN AUTHOR: <=1 follower, <=5 repos — typical of junk/malware accounts
in past scans; scrutinize before starring` — тоже подсказка, не запрет.
После URL — контекстная строка репо + автора (звёзды, форки, лицензия,
язык, дата последнего пуша, followers/repos автора); части с NULL-данными
просто опускаются, вплоть до полного отсутствия строки, если метаданных нет.
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
  сортировка, security-последние), вывод html_url/profile из PK, миграция
  на старой схеме (interest + author-signal колонки), запись repo-метаданных
  при вставке, `setAuthorMeta`, граничные случаи `isThinAuthor`.
- `gh`: парсинг search-результата (метаданные + фолбэк лицензии), пропуск
  archived/template, `fetchAuthor` (happy path + все варианты отказа → null).

## Чего сознательно нет (YAGNI)

- Демона/бесконечного цикла — `scan` запускается руками (cron — потом,
  если захочется).
- HTML/TUI-интерфейсов, метрик, дашбордов.
- Авто-действий по порогу — принципиально: только человек решает.
- Конфига моделей per-query, многостраничного поиска, ретраев с backoff
  внутри одного scan, тюнинга лимитов дайджеста через конфиг.
