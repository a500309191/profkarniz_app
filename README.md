# ProfKarniz App — milestone 1.5

Пассивный сборщик новых Telegram-сообщений для внутренней системы ПРОФКАРНИЗ.
Node.js 24 + TypeScript + PostgreSQL 17 + приватный Selectel S3. Один процесс выполняет long polling,
опционально архивирует вложения и предоставляет `GET /health`. Бот ничего не отправляет, не редактирует, не удаляет,
не отвечает и не ставит реакции. В клиенте доступны только `getMe`, `getWebhookInfo`
`getUpdates` и `getFile`, а также скачивание файлов. Архивирование включается явно;
при `MEDIA_ARCHIVE_ENABLED=false` S3 credentials не нужны.

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

отдельный worker читает только COMMIT-нутые telegram_message_events
        │
telegram_media_objects    durable jobs + результат, UNIQUE(event_id, attachment_index)
        │ короткий COMMIT, затем без открытой транзакции БД
getFile → download stream → SHA-256 / size → private S3 PutObject
        │
telegram_media_objects    archived + bucket/key/size/hash/etag
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
типы всегда остаются в raw update. При включённом архиве поддерживаемые вложения
скачиваются отдельным worker; ошибка S3 не откатывает raw update и не задерживает
подтверждение polling.

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
`raw input → parser prediction → human ground truth`. В milestone 1.5 этих сущностей,
парсера заказов, AI/LLM, CRM и frontend нет.

## Структура

```text
src/
  main.ts                   запуск, сигналы и освобождение ресурсов
  config.ts                 валидация environment variables
  logger.ts                 структурированные безопасные логи
  telegram/
    client.ts               read-only Telegram Bot API
    transport.ts            отдельный Undici Agent: IPv6-first + IPv4 fallback
    network-check.ts        диагностика DNS/IPv4/IPv6 без токена
    normalize.ts            проекция сообщений и metadata
    collector.ts            polling, retries, подтверждение после COMMIT
  db/
    client.ts, types.ts      pg pool и типы Kysely
    store.ts                атомарное сохранение и cursor
    lock.ts                 один poller на bot_id
    migrations.ts           versioned migration provider
    migrate.ts              отдельная команда миграции
    migrations/001_*.ts     начальная схема и immutable triggers
    migrations/002_*.ts     media jobs и cursor обнаружения вложений
  media/
    discovery.ts            выбор вложений и безопасные детерминированные keys
    repository.ts           jobs, leases, recovery, backfill
    archive.ts, streams.ts  bounded streaming, SHA-256, reconciliation
    s3.ts                   AWS SDK v3, private conditional PUT, HEAD/GET
    worker.ts, errors.ts    concurrency, backoff, safe error codes
    config.ts, cli.ts       feature flag, s3-check/backfill/retry-failed
  http/health.ts            GET /health
tests/                      unit, настоящий PostgreSQL и Linux process smoke test
docker-compose.yml          application + PostgreSQL + one-shot migrate
docker-compose.dev.yml      локальный доступ к БД только через loopback
docker-compose.host-network.yml  opt-in Linux VPS: IPv6 через сеть хоста
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
| `HTTP_PORT` | `3000` | Порт хоста; внутри bridge-контейнера 3000, в host-mode тот же HTTP_PORT |
| `HOST_POSTGRES_PORT` | `55432` | Только host-network override: порт БД на 127.0.0.1 хоста |
| `LOG_LEVEL` | `info` | trace/debug/info/warn/error/fatal/silent |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | `30` | Long poll, от 1 до 50 секунд |
| `HEALTH_STALE_SECONDS` | `120` | Допустимый возраст успешного цикла, 60–3600 секунд |
| `SHUTDOWN_TIMEOUT_SECONDS` | `25` | Deadline завершения, 5–120 секунд |
| `TEST_DATABASE_URL` | нет | Только integration tests, имя БД должно кончаться `_test` |
| `MEDIA_ARCHIVE_ENABLED` | `false` | Строго `true`/`false`; включает worker |
| `S3_ENDPOINT` | нет | HTTPS origin без пути, credentials, query/hash; в примере `https://s3.ru-7.storage.selcloud.ru` |
| `S3_REGION` | нет | Регион, для production `ru-7` |
| `S3_BUCKET` | нет | Уже созданный **private** bucket, для production `profkarniz-storage` |
| `S3_FORCE_PATH_STYLE` | `true` | `true`: bucket в пути; `false`: virtual-hosted-style для DNS-совместимого имени bucket |
| `S3_ACCESS_KEY_ID` | нет | Ключ доступа, только environment |
| `S3_SECRET_ACCESS_KEY` | нет | Секретный ключ, только environment |
| `MEDIA_CONCURRENCY` | `2` | Одновременные jobs, 1–4 |
| `MEDIA_MAX_ATTEMPTS` | `5` | Попытки на job до `failed`, 1–20 |
| `MEDIA_JOB_TIMEOUT_SECONDS` | `180` | Общий deadline одной попытки, 1–1800 секунд |
| `MEDIA_MAX_FILE_BYTES` | `20971520` | Верхняя граница файла, не выше 20 MiB |

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

При включении media все пять `S3_*` обязательны и проверяются при старте.
При выключении не создаётся S3 client, не запускается media worker и не изменяются
существующие media jobs. Миграция 002 всё равно нужна новой версии приложения.

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

## Telegram по IPv6 на VPS с недоступным IPv4

Telegram client использует отдельный Undici Agent, переданный в каждый вызов
Node.js 24 `fetch` через `dispatcher`. Закреплена совместимая версия Undici 7;
переход на следующий major требует повторной проверки dispatcher API с встроенным
fetch конкретного Node.js 24. Системный DNS resolver вызывается с
`order: ipv6first`, `family: 0`, `hints: 0`; Node получает AAAA и A без неявного
ADDRCONFIG-фильтра. `autoSelectFamily: true` включает штатный подбор семейства
адресов: первым пробуется IPv6, затем IPv4 и остальные адреса. На неуспешную
попытку до следующего адреса выделяется 250 мс, общий connect timeout — 10 секунд.
При немедленной ошибке, например ENETUNREACH, переход выполняется сразу. Если
есть только A-записи или рабочий IPv4, запросы продолжают работать через IPv4.
Это алгоритм Node для установления TCP-соединения; он не повторяет запрос по
другому семейству при HTTP-ошибке или после уже установленного TCP/TLS соединения.

Адреса Telegram не зафиксированы в коде и читаются из DNS при новом соединении;
открытые соединения переиспользуются. URL остаётся `https://api.telegram.org`, SNI
и проверка сертификата по этому имени сохраняются (`rejectUnauthorized: true`).
Глобальные DNS/fetch defaults, PostgreSQL и IPv4 ОС не меняются. `NODE_OPTIONS`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, VPN и proxy для этого решения не нужны.

Временные сетевые ошибки при начальном `getMe`/`getWebhookInfo` теперь повторяются
с backoff так же, как polling, без цикла перезапуска контейнера. Пока связи нет,
`/health` отвечает 503. При SIGTERM ожидание прерывается, Agent закрывается. Логи
содержат только разрешённые `network_codes` (например UND_ERR_CONNECT_TIMEOUT,
ENETUNREACH, ENOTFOUND), без URL с токеном или текста исходной ошибки.

### Проверка сети именно внутри контейнера

Успешный `curl -6` на хосте не доказывает IPv6-доступность из Docker bridge.
Базовый `docker-compose.yml` не включает IPv6 для default bridge. Само наличие
AAAA в DNS тоже не означает, что у контейнера есть IPv6-адрес и маршрут наружу.
На VPS сначала соберите новую версию и проверьте её без запуска второго poller:

```bash
docker compose build
docker compose run --rm --no-deps application node dist/telegram/network-check.js
```

Диагностика делает только `HEAD https://api.telegram.org/`, без bot token,
Bot API методов и перехода по редиректам. Она выводит DNS-адреса и результат
для IPv4-only, IPv6-only и того же IPv6-first/fallback транспорта, что у бота.
Ответ HTTP (в том числе 302) означает успешное TCP/TLS/HTTP-соединение; это не
проверка credentials. Код выхода 0 означает успех режима с fallback, 1 — его
неудачу. Принудительная проверка недоступного семейства может занять 12 секунд.

Для default project network (если меняли project name, используйте его имя):

```bash
docker network inspect profkarniz_default --format '{{.EnableIPv6}}'
```

Если host IPv6 работает, а bridge IPv6 — нет, для этого небольшого сервиса есть
готовый вариант ниже. Другой вариант — корректно настроенная dual-stack bridge
с IPv6 IPAM, forwarding и IPv6 masquerading/маршрутизацией. Одного
`enable_ipv6: true` недостаточно для гарантии внешнего доступа на любом VPS;
после сетевых изменений всё равно запускайте диагностику **в контейнере**.

### Готовый Linux-вариант без изменения Docker daemon или системного IPv4

`docker-compose.host-network.yml` подключает **только application** к сети Linux
хоста. Так приложение использует тот же IPv6-маршрут, по которому работает
`curl -6` хоста. PostgreSQL и мигратор сохраняют bridge-сеть. Для приложения
PostgreSQL публикуется только на `127.0.0.1:${HOST_POSTGRES_PORT:-55432}`;
HTTP также слушает только `127.0.0.1:${HTTP_PORT:-3000}`. Публичных bind-адресов
`0.0.0.0`/`::` этот override не добавляет. Healthcheck учитывает выбранный HTTP_PORT.

Нужны Linux Docker Engine >= 28 и Compose >= 2.24.4 (поддержка `!reset`). Этот
вариант уменьшает сетевую изоляцию application: процесс видит сетевые сервисы
хоста. Read-only filesystem, непривилегированный пользователь и cap_drop остаются.
Он не требуется машинам с рабочим IPv4 или уже настроенной IPv6 bridge.
Не смешивайте его с `docker-compose.dev.yml`.

До переключения можно проверить IPv6 через host network, не останавливая сервис:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps application node dist/telegram/network-check.js
```

Если режим `ipv6first-with-fallback` успешен, выберите свободные порты
HOST_POSTGRES_PORT/HTTP_PORT в `.env` и выполните из **того же каталога проекта**:

```bash
docker compose stop application
docker compose -f docker-compose.yml -f docker-compose.host-network.yml up -d
docker compose -f docker-compose.yml -f docker-compose.host-network.yml ps -a
curl -i http://127.0.0.1:3000/health
```

Команда предполагает, что `docker compose build` из шага выше уже выполнена.
Если HTTP_PORT отличается от 3000, подставьте его в curl. PostgreSQL будет
пересоздан для публикации loopback-порта; заранее выберите короткое окно
обслуживания. Имя Compose-проекта и persistent volume остаются прежними, миграции
данных для этой правки не нужны. Не используйте `down -v` и не меняйте project name.
Если ранее задавали `-p`, сохраняйте тот же `-p` во всех командах.

После переключения используйте оба `-f` при каждом `up`, `run` и обновлении, чтобы
случайно не вернуть bridge networking. Обновление: build с обоими файлами, затем
stop application и up -d с обоими файлами. Для возврата на базовый bridge:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml stop application
docker compose -f docker-compose.yml up -d
```

Возвращайтесь к bridge только если его IPv4 или IPv6-доступ к Telegram проверен.
VPS firewall и ограничения провайдера могут по-прежнему влиять на соединения;
диагностика и `/health` показывают фактический результат после развёртывания.

## Media archive → Selectel S3

### Данные и выбор файлов

Raw Telegram metadata остаётся source of truth в PostgreSQL. Миграция
`002_media_archive` добавляет две таблицы, не меняя immutable updates/events:

- `telegram_media_objects`: отдельная запись на event/attachment, Telegram file IDs,
  исходное имя/MIME/reported size, сохранённые endpoint/bucket/key, downloaded size,
  SHA-256, ETag, статус, даты, число попыток, безопасный error code, срок следующей
  попытки и lease/token текущего исполнителя.
- `telegram_media_discovery`: cursor событий для каждого bot_id. При первом
  включении он начинается с последнего уже сохранённого события; старые события
  добавляются командой backfill. При последующих стартах продолжается сохранённый
  cursor, поэтому ещё не обнаруженная работа после предыдущего запуска не теряется.

Worker архивирует `photo`, `document`, `video`, `voice`, `audio`, `animation`,
`video_note`. Для photo выбирается наибольшая площадь width × height, при равенстве —
больший file_size. Все PhotoSize и thumbnail metadata сохраняются в исходном event,
но thumbnails отдельно не скачиваются. Дублирующий document той же animation
не создаёт второй архив. Sticker и неизвестные media остаются в raw без job.
Альбом обрабатывается как отдельные события его сообщений.

Ключ объекта имеет вид:

```text
telegram/<bot_id>/<chat_id>/<UTC YYYY>/<MM>/<message_id>/events/<event_id>/<attachment_index>-<safe_file_unique_id>.<ext>
```

Event ID разделяет редакции сообщения и business contexts. Одинаковый файл в
разных сообщениях получает отдельные связи и объекты; глобальной дедупликации нет.
Attachment index соответствует массиву metadata исходного event. Если unique ID
отсутствует или содержит небезопасные символы, используется SHA-256 его значения
либо file_id (это хеш идентификатора, отдельный от хеша содержимого).
Имя пользователя никогда не становится путём: используется только проверенное
короткое расширение, затем MIME, иначе `.bin` (в том числе для PhotoSize без имени/MIME).
Путь `getFile.file_path` применяется только к текущему download и не записывается
в media records; URL с bot token нигде не сохраняется и не логируется.

### Streaming, retries и восстановление

Официальный cloud Bot API позволяет скачать через `getFile` файлы до 20 MB;
приложение ограничивает поток 20 MiB, а отказ Telegram на его границе обрабатывает
как ошибку конкретного файла. Лимит приложения можно уменьшить. Для больших файлов
сохраняется raw/metadata и `failed` с `MEDIA_TOO_LARGE` либо
`TELEGRAM_FILE_UNAVAILABLE`. Это не останавливает collector.
Срок действия download URL ограничен; каждая новая попытка вызывает `getFile` заново.
[Ограничения Telegram getFile](https://core.telegram.org/bots/api#getfile).

При известной длине работает pipeline `Telegram stream → hash/count → S3 stream`.
Файл не собирается в Buffer; backpressure ограничивает буферы. Если ни getFile,
ни HTTP не сообщили длину, worker сначала пишет ограниченный по размеру поток во
временный файл, затем передаёт его одним потоковым PUT с известным Content-Length.
В Compose `/tmp` — ограниченный tmpfs 128 MiB: редкий spool расходует до
`concurrency × max_file_bytes` (40 MiB при defaults, максимум 80 MiB), плюс буферы.
В обычном Node.js используется системный temp directory. Временный файл удаляется
после попытки; tmpfs очищается при пересоздании контейнера. Недостаток места не
теряет job. Concurrency по умолчанию 2, максимум 4 для VPS с 2 GB RAM.

Размер cloud Telegram файлов позволяет использовать один `PutObject` без multipart,
`AbortMultipartUpload` и `DeleteObject`. SDK не повторяет уже прочитанный stream:
повторами управляет очередь в PostgreSQL. SHA-256 вычисляется по полученным байтам;
ETag сохраняется отдельно и не считается SHA-256.

Состояния: `pending → downloading → uploading → archived`. Ошибка переводит job
в `pending` с `next_attempt_at` либо в `failed`. Claim и смены состояния — короткие
транзакции; Telegram/S3 I/O выполняются после их завершения. Индексы покрывают
pending jobs, leases и состояние по bot_id. `FOR UPDATE SKIP LOCKED` и attempt token
защищают job от конкурентного claim и записи результата устаревшей попыткой.
Worker использует существующий bot advisory lock вместе с collector.

Network, Telegram 429 и S3 5xx повторяются с exponential backoff от 5 секунд и
jitter 0.5–1.5; базовая задержка ограничена часом, учитывается Telegram retry_after.
После `MEDIA_MAX_ATTEMPTS` job становится `failed`. Telegram invalid file и S3
401/403 не повторяются автоматически. При SIGTERM потоки прерываются, job
возвращается в pending без расходования попытки. После аварийного завершения
новый владелец advisory lock восстанавливает активные jobs; зависшие leases
также возвращаются в очередь по сроку. Pending jobs и их retry dates сохраняются.

Перед скачиванием worker делает HEAD детерминированного ключа. PUT содержит
`If-None-Match: *` и техническую metadata `archive-id`. Если upload завершился,
но запись в БД не подтвердилась, следующая попытка сверяет archive-id, читает
существующий объект потоком, вычисляет SHA-256/size и отмечает job `archived`.
Другой archive-id даёт `S3_IDENTITY_MISMATCH`; чужой объект не перезаписывается.
Конфликт условной записи повторяется через ту же сверку. Повтор не создаёт новый key.
Смена настроенных endpoint/bucket не переносит старые jobs: они сохраняют назначение
и дают `S3_DESTINATION_CHANGED`, пока соответствующая настройка не восстановлена.

### Private bucket и права

Создайте bucket `profkarniz-storage` как **private**, без публичной bucket policy.
Приложению нужны только:

| Запрос | Право | Resource в JSON policy |
| --- | --- | --- |
| `ListObjectsV2` | `s3:ListBucket` | `arn:aws:s3:::profkarniz-storage` |
| `PutObject` | `s3:PutObject` | `arn:aws:s3:::profkarniz-storage/telegram/*` и `arn:aws:s3:::profkarniz-storage/test/*` |
| `HeadObject` | `s3:GetObject` | Те же object resources |
| `GetObject` | `s3:GetObject` | Те же object resources |

`arn:aws:s3:::profkarniz-storage/*` также покрывает оба префикса. Отдельных действий
`s3:HeadObject` / `s3:ListObjectsV2` добавлять не нужно. HEAD использует право чтения
объекта; ListBucket также позволяет отличить отсутствующий объект (404) от запрета
доступа (403). Наш SDK не вызывает ListBuckets или GetBucketLocation, не передаёт
ACL, tags, versionId или KMS-параметры.
[ListObjectsV2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html),
[PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html),
[HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html),
[GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

В Selectel достаточно роли `s3.bucket.user` в проекте бакета и Bucket policy с
этими Allow для ID сервисного пользователя. В `Principal.AWS` нужен его ID из
Selectel, а не отображаемое имя или Access Key. Если Resource в экспортированном
JSON содержит только имя бакета, исправьте его на указанный ARN; отображение имени
в UI само по себе не означает ошибку. Учитываются также Deny и Conditions.
Повышение до `s3.admin` для этих запросов не требуется.
[Selectel: доступ в S3](https://docs.selectel.ru/s3/about/manage-access/),
[структура Bucket policy](https://docs.selectel.ru/s3/buckets/bucket-policy/about-bucket-policy/).

Права DeleteObject, ACL, создание bucket и управление lifecycle не нужны.
Приложение не публикует объекты, не создаёт presigned/public URLs и не предоставляет
endpoint чтения файлов. Приватность существующей bucket policy контролируется
в Selectel: команда доступа не меняет и не проверяет её. AWS SDK v3 использует
выбранный стиль адресации, SigV4 и TLS verification; Selectel поддерживает conditional writes.
[Selectel S3 compatibility](https://docs.selectel.ru/en/api/object-storage-s3/).

### vHosted и диагностика AccessDenied

Selectel описывает vHosted как `<bucket>.<s3-domain>` и рекомендует этот тип при
создании бакета. Однако его инструкция для S3 Browser допускает Path-Style и для
vHosted-бакетов. Поэтому один HTTP 403 не доказывает несовместимость адресации.
[Типы адресации](https://docs.selectel.ru/s3/buckets/addressing-types/),
[настройка S3 Browser, шаг 11](https://docs.selectel.ru/s3/tools/s3-browser/).

`S3_FORCE_PATH_STYLE=true` сохраняет прежнее поведение. Для явного vHosted задайте
`S3_FORCE_PATH_STYLE=false`. При текущих production параметрах SDK сформирует:

```text
true:  https://s3.ru-7.storage.selcloud.ru/profkarniz-storage/<key>
false: https://profkarniz-storage.s3.ru-7.storage.selcloud.ru/<key>
```

`S3_ENDPOINT` в обоих случаях остаётся региональным
`https://s3.ru-7.storage.selcloud.ru`, bucket указывается отдельно. Не добавляйте
имя бакета в endpoint вручную. Для данного имени без точек SDK использует
virtual-hosted-style при `false`; для IP endpoints и несовместимых имён SDK может
выбрать path-style. TLS verification не отключается. Смена стиля не меняет key,
bucket или сохранённое назначение jobs.

`s3:check` выполняет запросы строго последовательно:
`ListObjectsV2(prefix=test/, max-keys=1) → PutObject(test/access-check-UUID.txt) → HeadObject → GetObject`.
После ошибки следующие операции не выполняются. Лог теперь показывает
`addressing_style`, начало каждой `operation`, а при ошибке — её имя, `http_status`
и `s3_code` из ограниченного списка безопасных значений. Пример формата ошибки
(не результат проверки вашего production):

```json
{"event":"media_command_failed","code":"S3_ACCESS_DENIED","operation":"ListObjectsV2","http_status":403,"s3_code":"AccessDenied"}
```

Старый `S3_ACCESS_DENIED` — обобщение любого 401/403; под ним мог скрываться,
например, `SignatureDoesNotMatch`. HEAD может не вернуть XML-код ошибки: тогда
`s3_code` будет `null` или `Forbidden`, но имя операции и HTTP status сохранятся.
Тексты ответов, request headers, подписи и credentials не печатаются.

После обновления кода и сборки сравните два режима с теми же credentials и policy:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml build application
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps -e S3_FORCE_PATH_STYLE=true application npm run s3:check
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps -e S3_FORCE_PATH_STYLE=false application npm run s3:check
```

Каждая успешная проверка оставляет свой маленький технический объект в `test/`.
Если path-style получает отказ, а vHosted проходит, закрепите
`S3_FORCE_PATH_STYLE=false` в `.env` и пересоздайте application с теми же Compose
файлами. Права при этом расширять не нужно.

Если отказ сохраняется, сопоставьте `operation` с таблицей прав. Для ListObjectsV2
проверьте разрешение ListBucket на ARN самого бакета и условия, допускающие `test/`
и `max-keys=1`. Для Put/Head/Get проверьте Allow на `test/*`; worker также требует
`telegram/*`. Если Allow уже корректны, проверяются совпадение Principal с владельцем
S3 key, роль в нужном проекте, Deny/Conditions и безопасный `s3_code` ошибки.
По одному старому коду без этапа нельзя достоверно назначить изменение policy.

### Обновление production с существующим host-network

Сохраните backup PostgreSQL. В защищённом `.env` добавьте параметры из `.env.example`:
endpoint `https://s3.ru-7.storage.selcloud.ru`, region `ru-7`, bucket
`profkarniz-storage`, обе реальные S3 credentials через редактор и
`MEDIA_ARCHIVE_ENABLED=true`. Не копируйте новый `.env.example` поверх рабочего `.env`.

Из того же каталога и с прежним Compose project name:

```bash
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.host-network.yml build
# Проверка только S3: не запускает poller, не отправляет пользовательские данные.
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps application npm run s3:check
docker compose -f docker-compose.yml -f docker-compose.host-network.yml stop application
docker compose -f docker-compose.yml -f docker-compose.host-network.yml run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.host-network.yml up -d application
docker compose -f docker-compose.yml -f docker-compose.host-network.yml logs --tail=100 application
curl -i http://127.0.0.1:3000/health
```

Первую S3-проверку можно выполнить и с `MEDIA_ARCHIVE_ENABLED=false`: CLI проверяет
все пять S3-переменных независимо от flag, без Telegram/БД. Она выполняет ListObjectsV2
для `test/`, записывает маленький технический объект `test/access-check-<UUID>.txt`,
проверяет HEAD и GET/hash. Код выхода 0 означает успех. **Объект остаётся в `test/`**,
каждый запуск создаёт новый; автоматического удаления нет. В лог попадает только
технический key и результат, без credentials и подписей запросов.

Для bridge deployment используйте те же команды без обоих `-f` аргументов.
IPv6-first Telegram Agent применяется также к getFile/download, host-network override
сохранён. После обновления проверьте свежие photo/document/video/voice: raw commit,
`media_archived` и metadata в БД. S3 доступ с production VPS подтверждает именно
его `s3-check`; mock tests не заменяют эту проверку.

### Backfill и ручной повтор

При работающем media worker создайте jobs из ранее сохранённых событий:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps application npm run media:backfill
```

Команда требует `MEDIA_ARCHIVE_ENABLED=true`, работает только с bot_id из текущего
токена и сканирует события до зафиксированного в начале max ID пакетами по 100.
Она только добавляет недостающие pending records: не скачивает файлы, не меняет
raw/history и не перемещает live cursor. Повторный запуск безопасен; archived и
failed записи не сбрасываются. Обработку продолжает основной worker. Backfill
можно прервать и запустить снова. Он не запрашивает старую историю у Telegram.

После исправления credentials, прав или причины permanent error:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-network.yml \
  run --rm --no-deps application npm run media:retry-failed
```

Команда сбрасывает только failed jobs текущего bot_id в pending и обнуляет число
попыток. Она не затрагивает archived/active jobs и не меняет их ключи назначения.
Просто рестарт приложения не сбрасывает failed. При временном отключении feature
сохранённые jobs остаются в БД, продолжение начинается после включения.

Эти же npm-команды работают в production Docker image и локально: они запускают
скомпилированный `dist/media/cli.js` и читают уже заданное окружение. Для локального
запуска сначала соберите проект:

```bash
npm run build
npm run s3:check
npm run media:backfill
npm run media:retry-failed
```

Для `.env` и собранного кода: `node --env-file=.env dist/media/cli.js s3-check`
(либо `backfill` / `retry-failed`). Production npm scripts не требуют `tsx` или
исходников TypeScript; `tsx` остаётся dev dependency для development-команд.
Секреты не передаются аргументами.

Проверка состояния без имён файлов и текста сообщений:

```bash
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT archive_status, count(*) FROM telegram_media_objects GROUP BY archive_status;"'
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, archive_status, downloaded_size, sha256, attempt_count, last_error_code FROM telegram_media_objects ORDER BY id DESC LIMIT 20;"'
```

Бинарные файлы лежат только в S3; SQL содержит ссылку на конкретный event/attachment
и результат архивирования. Backup PostgreSQL и сохранность приватных S3 objects
нужно обеспечивать совместно. Удаление и lifecycle policies этим milestone не управляются.

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

`200`: БД отвечает, последний цикл polling успешно завершён недавно.
Пустой успешный ответ Telegram тоже подтверждает работоспособность.
`503`: запуск, retry, остановка, ошибка/таймаут БД или устаревший polling.
При первом запуске 503 может сохраняться до завершения первого long poll.

```json
{"status":"ok","database":"up","collector":{"phase":"running","healthy":true,"last_success_at":"2026-09-30T00:00:00.000Z","last_error":null},"media_archive":{"status":"ok","pending":0,"failed":0,"last_scan_at":"2026-09-30T00:00:00.000Z","last_error_code":null}}
```

`media_archive` независимо сообщает `disabled`, `ok` или `degraded`, количество
незавершённых (включая active) и failed jobs. Ошибки media и отсутствие свежего
scan более 30 секунд дают degraded, но не меняют HTTP 200 здорового collector.
Данные media берутся из последнего прохода worker; HTTP health не обращается к S3.
`ok` без jobs не является активной проверкой S3 credentials — для неё есть `s3:check`.

Health содержит только техническое состояние. Structured JSON logs содержат
события старта, соединения с БД, polling, количество полученных/сохранённых
updates и дублей, категории ошибок и retry delay. Тексты, имена отправителей,
file_id и содержимое raw update в production logs не выводятся.
Media-события: `media_discovered`, `media_download_started`, `media_upload_started`,
`media_archived`, `media_retry`, `media_failed`; только internal IDs, тип, размер,
duration, число попыток и безопасные error codes. Исходные исключения SDK не печатаются.
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
npm run test:compose         # проверка base/host-network Compose без старта сервисов
docker build --target runtime -t profkarniz-app:ci .
npm run test:production-cli  # реальные npm entrypoints внутри runtime image
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

Сетевые тесты используют реальные локальные сокеты IPv4/IPv6 и Node fetch с тем
же Agent: IPv6-first, отказ IPv6 с fallback на IPv4, только A или только AAAA.
Публичный DNS и Telegram для них не нужны; достаточно IPv6 loopback. Тестовый
Compose включает его только внутри тестового контейнера через namespaced sysctl.
Process test также имитирует начальный UND_ERR_CONNECT_TIMEOUT и проверяет
восстановление в том же процессе. `test:compose` требует Docker Compose, проверяет
loopback bind, custom ports, host-mode только у application и сохранение имени
volume; полный config с секретами не печатается. Эти проверки также запускаются CI.

Media tests проверяют key/path safety, extensions, photo selection, discovery,
feature flag, Telegram download через тот же dispatcher, bounded streams/SHA-256,
retry/backoff, безопасные ошибки и восстановление после сбоя. Локальный HTTP S3 mock
принимает настоящие SigV4-запросы AWS SDK и имитирует потерю ответа после PUT;
проверяются HEAD/GET reconciliation, private conditional PUT и `s3:check` без DELETE.
PostgreSQL tests проверяют jobs, backfill, дубли, редакции, leases/fencing, restart,
ручной retry и ограничение concurrency при продолжающейся записи raw updates.
CI не обращается к реальному Telegram/Selectel и не требует S3 credentials.

После сборки runtime image CI отдельно запускает внутри него `npm run s3:check`,
`npm run media:backfill` и `npm run media:retry-failed`. Smoke test проверяет наличие
скомпилированного CLI, отсутствие `src`/`tsx` и запуск от непривилегированного
пользователя. Контейнеры запускаются без сети, credentials и монтирования исходников;
ожидается штатная структурированная ошибка проверки окружения с exit code 1.
Ошибка shell/импорта вместо этой проверки проваливает тест. Проверку реальных
credentials выполняет отдельный production `s3:check`. Для другого тега image:
`npm run test:production-cli -- profkarniz-app:local`.

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
SELECT/INSERT/UPDATE для cursor, media jobs/discovery и доступ к sequences; DDL нужен только мигратору.
Не открывайте PostgreSQL публично; для внешней БД настройте проверяемый TLS/сеть
отдельно. Реальные credentials и настройки конкретного VPS в репозиторий не входят.

## Документация используемых API

- [Telegram getUpdates и подтверждение offset](https://core.telegram.org/bots/api#getupdates)
- [Ограничения доставки Telegram updates](https://core.telegram.org/bots/api#getting-updates)
- [Telegram Privacy Mode](https://core.telegram.org/bots/features#privacy-mode)
- [Kysely migrations](https://kysely.dev/docs/migrations)
- [Node.js 24 DNS order](https://nodejs.org/docs/latest-v24.x/api/dns.html#dnslookuphostname-options-callback)
- [Node.js autoSelectFamily](https://nodejs.org/docs/latest-v24.x/api/net.html#socketconnectoptions-connectlistener)
- [Undici connector options](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md)
- [Docker host networking](https://docs.docker.com/engine/network/drivers/host/)
- [Telegram getFile](https://core.telegram.org/bots/api#getfile)
- [Selectel S3 API и совместимость](https://docs.selectel.ru/en/api/object-storage-s3/)
