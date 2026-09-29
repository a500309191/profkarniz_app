# ProfKarniz App — milestone 1

Пассивный сборщик новых Telegram-сообщений для внутренней системы ПРОФКАРНИЗ.
Node.js 24 + TypeScript + PostgreSQL 17. Один процесс выполняет long polling и
предоставляет `GET /health`. Бот ничего не отправляет, не редактирует, не удаляет,
не отвечает и не ставит реакции. В клиенте доступны только `getMe`, `getWebhookInfo`
и `getUpdates`.

## Архитектура и гарантии

```text
Telegram getUpdates
        │
        ▼  одна транзакция PostgreSQL на полученный пакет (до 100 updates)
telegram_updates          immutable JSONB, UNIQUE(bot_id, update_id)
        │
telegram_messages         identity, UNIQUE(bot_id, chat_id, message_id, context_key)
        │
telegram_message_events   immutable снимки полученных версий + metadata вложений
        │
telegram_polling_state    сохранённая позиция polling
        │ COMMIT
        ▼
следующий getUpdates(offset) подтверждает только сохранённые updates
```

Доставка допускает повторы, запись идемпотентна. Если процесс падает до COMMIT,
пакет не подтверждается и придёт снова. Если он падает после COMMIT, но до
подтверждения, unique constraints исключают повторную запись. Ошибка сохранения
откатывает весь пакет, включая позицию polling. Ошибки БД и временные ошибки
Telegram повторяются с задержкой до 30 секунд и небольшим jitter; при 429
учитывается `retry_after`. Невалидный пакет не пропускается молча.

Исходный update хранится целиком, включая неизвестные поля, entities, nested reply,
forward origin и служебные события. JSONB сохраняет значения JSON, но нормализует
форматирование и порядок ключей: это не побайтовая копия HTTP-ответа.
Триггеры запрещают UPDATE, DELETE и TRUNCATE исходных updates и событий сообщений.
Владелец БД/суперпользователь технически может снять эту защиту; защита рассчитана
на обычные операции приложения, а не на противодействие администратору БД.

Одна запись `telegram_messages` обозначает сообщение; каждый новый update с
редакцией добавляет `telegram_message_events`, сохраняя исходную версию. Повторное
сообщение в другом update не создаёт вторую identity, но сам новый update остаётся
в истории. Даже если первой пришла редакция, она создаёт identity. Последняя
полученная версия — событие с наибольшим `id` внутри этой identity. `bot_id`
разделяет пространства разных ботов; `context_key` хранит business connection ID,
если Telegram его прислал. Telegram ID представлены `bigint` в БД и строками в коде.

Сохраняются текст, caption, sender и sender_chat, время отправки/редактирования,
reply ID, thread ID, album ID, forward metadata. Для фото сохраняются все размеры,
для документов, видео, voice, audio, animation, sticker и video_note — file_id,
file_unique_id, исходная metadata, thumbnails и дополнительные поля. Неизвестные
типы всегда остаются в raw update. Вложения не скачиваются.

Альбомы сохраняются отдельными сообщениями с `media_group_id`; связывать их нужно
в контексте бота и чата. Вложенный reply хранится в raw update, но не создаёт
отдельное сообщение или вложения родительского сообщения.

Session advisory lock PostgreSQL разрешает одному сборщику работать с конкретным
bot_id в одной БД. Потеря соединения, удерживающего lock, останавливает процесс.
Не запускайте второй poller с тем же ботом в другой БД: PostgreSQL не может
координировать такие процессы; Telegram обычно вернёт 409. 400/401/403/404/409
считаются фатальными и требуют проверки настройки. Существующий webhook приводит
к отказу запуска; сборщик не удаляет его и не сбрасывает очередь.

После длительного простоя Telegram может изменить последовательность update_id.
Позиция старше шести дней не передаётся в getUpdates: сервер возвращает самые
ранние неподтверждённые updates, а уникальность в БД делает повтор безопасным.
Никогда не используется отрицательный offset или `drop_pending_updates`.

### Почему Kysely

Kysely — небольшой типизированный query builder без ORM-моделей и автоматической
синхронизации схемы. Он оставляет транзакции, JSONB, ограничения и блокировки
PostgreSQL явными. Встроенный Migrator ведёт таблицу версий `kysely_migration`,
блокирует конкурирующие миграции и применяет их транзакционно. Схему меняет
отдельная команда/Compose-сервис, основной процесс только проверяет её версию.

### Следующие этапы

Будущая цепочка: `TelegramMessage → IncomingBundle → DraftOrder → Human Validation → Order`.
Bundle сможет ссылаться на IDs сообщений и конкретных событий. Предсказания parser
и человеческие исправления следует хранить в отдельных новых таблицах с версиями
parser и ссылками на исходные события, чтобы получать dataset
`raw input → parser prediction → human ground truth`. В milestone 1 этих сущностей,
парсера заказов, AI/LLM, CRM и frontend нет.

## Структура

```text
src/
  main.ts                   запуск, сигналы и освобождение ресурсов
  config.ts                 валидация environment variables
  logger.ts                 структурированные безопасные логи
  telegram/
    client.ts               read-only Telegram Bot API
    normalize.ts            проекция сообщений и metadata
    collector.ts            polling, retries, подтверждение после COMMIT
  db/
    client.ts, types.ts      pg pool и типы Kysely
    store.ts                атомарное сохранение и cursor
    lock.ts                 один poller на bot_id
    migrations.ts           versioned migration provider
    migrate.ts              отдельная команда миграции
    migrations/001_*.ts     начальная схема и immutable triggers
  http/health.ts            GET /health
tests/                      unit, настоящий PostgreSQL и Linux process smoke test
docker-compose.yml          application + PostgreSQL + one-shot migrate
docker-compose.dev.yml      локальный доступ к БД только через loopback
docker-compose.test.yml     изолированные тесты без реального токена
.github/workflows/ci.yml    typecheck, lint, тесты, сборка Docker
```

## Environment variables

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | обязательна для app | Секрет Telegram; мигратору не нужен |
| `POSTGRES_PASSWORD` | обязательна | Пароль PostgreSQL |
| `POSTGRES_USER` | `profkarniz` | Пользователь БД |
| `POSTGRES_DB` | `profkarniz` | Имя БД |
| `PGHOST` | `127.0.0.1` | В Compose принудительно `postgres` |
| `PGPORT` | `5432` | Порт; в Compose внутренний порт фиксирован |
| `HTTP_HOST` | `127.0.0.1` | В контейнере `0.0.0.0` |
| `HTTP_PORT` | `3000` | Локальный порт; внутри контейнера всегда 3000 |
| `LOG_LEVEL` | `info` | trace/debug/info/warn/error/fatal/silent |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | `30` | Long poll, от 1 до 50 секунд |
| `HEALTH_STALE_SECONDS` | `120` | Допустимый возраст успешного цикла, 60–3600 секунд |
| `SHUTDOWN_TIMEOUT_SECONDS` | `25` | Deadline завершения, 5–120 секунд |
| `TEST_DATABASE_URL` | нет | Только integration tests, имя БД должно кончаться `_test` |

Все секреты поступают через environment variables. `.env` — локальный способ
задать их, исключённый из Git и Docker build context; Compose передаёт сервисам
только нужные значения. Не передавайте токен в команде shell, URL браузера, PR,
issue или логах. На Ubuntu:

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Заполните пустые `TELEGRAM_BOT_TOKEN` и `POSTGRES_PASSWORD` в редакторе. Для символов
`$`/`#` и пробелов используйте одинарные кавычки вокруг значения в `.env`.
Не публикуйте вывод `docker compose config`, `docker inspect` или env: они могут
показывать секреты. Приложение не пишет API descriptions, HTTP URLs, SQL params,
stack traces с исходными ошибками или полный текст сообщений в логи.

## Запуск на Ubuntu VPS через Docker Compose

Нужны Docker Engine с Compose v2, исходящие HTTPS-соединения к Telegram и место
для PostgreSQL volume. TLS на публичном входе не требуется: HTTP API привязан
к `127.0.0.1`; PostgreSQL вообще не публикует порт хоста.

```bash
git clone https://github.com/a500309191/profkarniz_app.git
cd profkarniz_app
cp .env.example .env
chmod 600 .env
nano .env
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 application migrate
curl -i http://127.0.0.1:3000/health
```

Сначала запускается БД, затем завершаются миграции, затем стартует приложение.
Данные лежат в именованном persistent volume `postgres_data`. Обычный
`docker compose down` сохраняет его; **`down -v` удаляет данные**.
Приложение работает от непривилегированного пользователя, с read-only filesystem,
без Linux capabilities. Логи Docker ограничены по размеру.

`SIGTERM`/`SIGINT` прерывает ожидающий HTTP long poll и retry sleep, дожидается
текущей транзакции, закрывает HTTP и БД и освобождает lock. По deadline процесс
завершается принудительно; незавершённая транзакция откатится. Compose даёт процессу
135 секунд, что больше максимального настраиваемого deadline приложения.

Для последовательного обновления и отдельного контроля миграций:

```bash
docker compose build
docker compose stop application
docker compose run --rm migrate
docker compose up -d application
```

Перед обновлением делайте резервную копию. Остановка должна быть короткой: очередь
Telegram ограничена по сроку хранения. Миграции применяются только вперёд;
разрушительный `down` для исходной истории намеренно не реализован.

## Локальный запуск Node.js

Нужны Node.js 24, npm и PostgreSQL 17 (можно поднять только БД в Docker).
После заполнения `.env`:

```bash
npm ci
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres
npm run migrate:local
npm run dev
```

Override открывает БД только на `127.0.0.1:${PGPORT}`. На VPS для обычного
контейнерного запуска этот override не нужен. Существующая локальная БД также
подходит — задайте host/port/user/password/database через окружение.

`npm run migrate` читает уже установленные environment variables; `migrate:local`
загружает `.env`. Для собранного приложения: `npm run build`, затем
`node --env-file=.env dist/db/migrate.js` и `node --env-file=.env dist/main.js`.
`npm start`/`npm run migrate:production` ожидают environment variables от окружения.

## Подключение Telegram-бота

1. Создайте отдельного бота в официальном `@BotFather` командой `/newbot`.
2. Сохраните токен локально в `.env` или в окружении сервиса.
3. Для получения обычных сообщений группы отключите Privacy Mode:
   `@BotFather` → `/setprivacy` → нужный бот → `Disable`.
4. Добавьте бота в рабочую группу. Если он был добавлен до изменения Privacy Mode,
   удалите его из группы и добавьте снова, чтобы настройка применилась.
5. Запустите сборщик и отправьте новое тестовое сообщение, файл и альбом.
6. Проверьте `updates_received`/`updates_saved` в логах и `/health`.

Не выдавайте права на удаление/изменение сообщений ради работы сборщика. Он
сохраняет все updates, которые Telegram отдаёт этому боту, включая личные чаты
и другие группы: используйте отдельного бота только в нужных рабочих чатах.
По умолчанию `allowed_updates: []` включает все стандартные типы; специальные
chat_member/message_reaction/message_reaction_count не запрашиваются.

Long polling не работает одновременно с webhook. Если `/health` недоступен и
в логах 409, проверьте другой экземпляр poller или ранее настроенный webhook.
Снимите старую интеграцию осознанно, без сброса pending updates, затем перезапустите.
401/404 обычно означают проблему с токеном; 403 — с доступом; при 400 проверьте
совместимость/настройку запросов. Для ошибок БД логируется SQLSTATE без SQL и данных.
При `MIGRATIONS_REQUIRED` выполните команду миграции.

Bot API не предоставляет всю историю группы и не гарантирует доставку событий,
которые бот не мог видеть. Telegram хранит ожидающие updates не более 24 часов;
простой дольше этого срока может привести к невосстановимой потере новых сообщений.
Сборщик обеспечивает надёжность для доступных и полученных updates, а не архив
истории Telegram. Изменения и удаления, о которых Telegram не прислал update,
восстановить невозможно.

## Health и наблюдаемость

```bash
curl -i http://127.0.0.1:3000/health
```

`200`: БД отвечает, последний цикл polling успешно завершён недавно, ошибок нет.
Пустой успешный ответ Telegram тоже подтверждает работоспособность.
`503`: запуск, retry, остановка, ошибка/таймаут БД или устаревший polling.
При первом запуске 503 может сохраняться до завершения первого long poll.

```json
{"status":"ok","database":"up","collector":{"phase":"running","healthy":true,"last_success_at":"2026-09-30T00:00:00.000Z","last_error":null}}
```

Health содержит только техническое состояние. Structured JSON logs содержат
события старта, соединения с БД, polling, количество полученных/сохранённых
updates и дублей, категории ошибок и retry delay. Тексты, имена отправителей,
file_id и содержимое raw update в production logs не выводятся.
Настройте внешнюю проверку loopback endpoint через VPS-мониторинг. Docker помечает
нездоровый контейнер, но сам по себе **не перезапускает** контейнер из-за healthcheck;
restart policy применяется к выходу процесса. Временные ошибки процесс повторяет.

Для подтверждения сохранения без раскрытия содержимого сообщений:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM telegram_updates;"'
```

## Тесты и CI

```bash
npm run check                # typecheck + lint + unit tests + build
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from tests
docker compose -f docker-compose.test.yml down
```

Тестовый Compose использует отдельный проект и временную БД в tmpfs без портов
хоста; фиксированный пароль `test-only-disposable` относится только к ней.
Production `.env` и реальный Telegram token для тестов не нужны. Unit tests
проверяют mapping, optional fields, media, offsets, retries, безопасность ошибок
и health. Integration tests проверяют миграции, реальные constraints/JSONB,
конкурирующие повторы, редакции, альбомы, rollback, immutable triggers и lock.
Linux process test запускает собранное приложение с mock Telegram transport,
проверяет запись, HTTP health и корректный SIGTERM. Реальные сообщения не отправляются.

Для существующей тестовой PostgreSQL задайте `TEST_DATABASE_URL` через окружение
и выполните `npm run build && npm run test:integration`. Без URL тесты завершаются
ошибкой, а не пропускаются. Имя БД должно оканчиваться `_test`; тесты создают и
удаляют только собственную случайную schema. На Windows только Linux SIGTERM
process test пропускается; Docker/CI выполняют его полностью.

## Резервные копии и эксплуатация

Persistent volume не заменяет backup. На Ubuntu создавайте регулярные `pg_dump`
в защищённый каталог и проверяйте восстановление на отдельной тестовой БД:

```bash
mkdir -p backups
chmod 700 backups
umask 077
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > backups/profkarniz.dump
```

Backup содержит персональные данные; храните его вне Git с ограниченным доступом.
README-команда предназначена для Bash/Ubuntu (не для перенаправления бинарных
данных старым Windows PowerShell). После восстановления БД из старой копии нельзя
восстановить из Telegram уже подтверждённые updates: нужна соответствующая политика
backup/PITR для требуемой допустимой потери данных.

Compose для простоты использует одного DB owner для миграций и приложения. При
усилении эксплуатации разделите роли: runtime нужны SELECT/INSERT для истории,
SELECT/INSERT/UPDATE для cursor и доступ к sequences; DDL нужен только мигратору.
Не открывайте PostgreSQL публично; для внешней БД настройте проверяемый TLS/сеть
отдельно. Реальные credentials и настройки конкретного VPS в репозиторий не входят.

## Документация используемых API

- [Telegram getUpdates и подтверждение offset](https://core.telegram.org/bots/api#getupdates)
- [Ограничения доставки Telegram updates](https://core.telegram.org/bots/api#getting-updates)
- [Telegram Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)
- [Kysely migrations](https://kysely.dev/docs/migrations)
