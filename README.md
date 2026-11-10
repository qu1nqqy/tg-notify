# tg-notify

GitHub Action для уведомлений CI/CD в Telegram: **одно сообщение на весь запуск**, которое обновляется на месте по мере выполнения шагов.

```
⏳ Запущена сборка…
• Репозиторий: qu1nqqy/rustos
• Ветка: master
• Автор: qu1nqqy

📝 test
✅ Run actions/checkout@v7
✅ cargo fmt --check
⏳ cargo clippy
⏳ Tests in QEMU

📝 release ⏳
```

- Один вызов в начале задачи. Статус остальных шагов action берёт из GitHub API сам: фоновый процесс опрашивает его раз в 5 с и правит сообщение, только если текст изменился.
- Основное сообщение и все правки беззвучные. При провале приходит **отдельный ответ со звуком** «❌ owner/repo: упало на <шаг>» с кнопкой «Открыть шаг». При успехе ничего нового не приходит.
- В тексте нет ссылок. Ссылки вынесены в кнопки: «Запуск», «Коммит», «PR» (для pull_request), «Релиз» (если запуск его создал).
- Несколько задач одного запуска пишут в одно сообщение: `message_id` передаётся через `needs`.
- Режим `release`: новое сообщение о релизе с файлами, закреплённое в теме проекта.
- Если секреты не заданы, action выводит предупреждение и не роняет задачу.

## Быстрый старт

```yaml
# .github/workflows/build.yml
name: build
on: [push, pull_request]

permissions:
  contents: read
  actions: read          # нужно, чтобы читать статус шагов

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: qu1nqqy/tg-notify@v1      # первым шагом
        with:
          token: ${{ secrets.TELEGRAM_TOKEN }}
          chat_id: ${{ secrets.TELEGRAM_CHAT_ID }}
          topic_id: ${{ vars.TELEGRAM_TOPIC_ID }}
      - uses: actions/checkout@v7
      - run: make test
```

## Бот и группа

1. Создайте бота у [@BotFather](https://t.me/BotFather) и сохраните токен.
2. Создайте группу и включите в ней **темы** (Настройки группы → Темы). Для каждого проекта создайте свою тему.
3. Добавьте бота в группу и сделайте **администратором** с правами:
   - «Закреплять сообщения» — для режима `release`;
   - «Управление темами» не нужно; писать в темы может любой участник.
4. Узнайте `chat_id` и `topic_id`. Проще всего по ссылке на любое сообщение в теме (ПКМ → «Копировать ссылку»):
   `https://t.me/c/1234567890/42/100` → `chat_id = -1001234567890`, `topic_id = 42`.
   Другой способ: отправьте в тему `/start@имя_бота` и откройте
   `https://api.telegram.org/bot<TOKEN>/getUpdates`: нужны `message.chat.id` и `message.message_thread_id`.
   В тему «General» пишите без `topic_id`.

## Секреты: две схемы

Action сам секреты не читает, их передаёт workflow через `${{ secrets.X }}`. GitHub ищет секрет по порядку:
**окружение → репозиторий → организация**. Поэтому workflow один и тот же для организации и для профиля.
Различается только место, где заданы секреты.

| имя | тип | где задавать |
|-----|-----|--------------|
| `TELEGRAM_TOKEN` | секрет | организация или репозиторий |
| `TELEGRAM_CHAT_ID` | секрет | организация или репозиторий |
| `TELEGRAM_TOPIC_ID` | переменная (`vars.`) | обычно репозиторий: у каждого проекта своя тема |

### Схема «организация»

Одна группа на организацию, по теме на проект.

1. Settings организации → Secrets and variables → Actions → **New organization secret**:
   `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`. В «Repository access» выберите нужные репозитории.
2. В каждом репозитории: Settings → Secrets and variables → Actions → вкладка **Variables** → `TELEGRAM_TOPIC_ID`.
3. Workflow — как в «Быстром старте».

Секрет репозитория с тем же именем **переопределяет** секрет организации. Так можно отправить один
репозиторий в другую группу. Если секреты организации должны иметь приоритет, задайте их под другим именем:

```yaml
token: ${{ secrets.ORG_TELEGRAM_TOKEN || secrets.TELEGRAM_TOKEN }}
chat_id: ${{ secrets.ORG_TELEGRAM_CHAT_ID || secrets.TELEGRAM_CHAT_ID }}
```

> **Тариф GitHub Free.** Секреты и переменные **уровня организации недоступны приватным репозиториям**
> на бесплатном тарифе организации (см. [документацию](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)).
> В workflow приватного репозитория `secrets.TELEGRAM_TOKEN` окажется пустым. Для приватных репозиториев
> на Free задайте секреты в самом репозитории (как в схеме «профиль») или перейдите на тариф Team.
> Публичным репозиториям секреты организации доступны и на Free.

### Схема «профиль»

У личного аккаунта нет секретов уровня профиля. Поэтому в каждом репозитории свои секреты
`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID` и переменная `TELEGRAM_TOPIC_ID`
(Settings репозитория → Secrets and variables → Actions). Токен и группа могут быть одни на все
репозитории, тема у каждого своя. Workflow — тот же.

Через `gh`:

```sh
gh secret set TELEGRAM_TOKEN   -R owner/repo
gh secret set TELEGRAM_CHAT_ID -R owner/repo --body -1001234567890
gh variable set TELEGRAM_TOPIC_ID -R owner/repo --body 42
```

## Пример: две задачи в одном запуске

`test` создаёт сообщение и отдаёт `message_id` наружу, `release` дописывает в то же сообщение свою секцию,
а потом отправляет отдельное сообщение о релизе с файлами.

```yaml
name: build
on:
  push:
  pull_request:

permissions:
  contents: read
  actions: read

jobs:
  test:
    runs-on: ubuntu-latest
    outputs:
      tg_message_id: ${{ steps.tg.outputs.message_id }}
    steps:
      - id: tg
        uses: qu1nqqy/tg-notify@v1
        with:
          token: ${{ secrets.TELEGRAM_TOKEN }}
          chat_id: ${{ secrets.TELEGRAM_CHAT_ID }}
          topic_id: ${{ vars.TELEGRAM_TOPIC_ID }}
      - uses: actions/checkout@v7
      - run: cargo fmt --check
      - run: cargo clippy -- -D warnings
      - run: cargo test

  release:
    needs: test
    if: github.event_name == 'push' && github.ref == 'refs/heads/master'
    runs-on: ubuntu-latest
    permissions:
      contents: write   # gh release create
      actions: read
    steps:
      - uses: qu1nqqy/tg-notify@v1
        with:
          token: ${{ secrets.TELEGRAM_TOKEN }}
          chat_id: ${{ secrets.TELEGRAM_CHAT_ID }}
          topic_id: ${{ vars.TELEGRAM_TOPIC_ID }}
          message_id: ${{ needs.test.outputs.tg_message_id }}
      - uses: actions/checkout@v7
      - run: make images
      - run: gh release create "v0.1.${{ github.run_number }}" dist/*.bin --generate-notes
        env:
          GH_TOKEN: ${{ github.token }}
      - uses: qu1nqqy/tg-notify@v1
        with:
          mode: release
          token: ${{ secrets.TELEGRAM_TOKEN }}
          chat_id: ${{ secrets.TELEGRAM_CHAT_ID }}
          topic_id: ${{ vars.TELEGRAM_TOPIC_ID }}
          files: dist/*.bin
```

Если задача объявляет свой блок `permissions`, он **заменяет** общий целиком. Поэтому `actions: read` нужно указать и в нём.

## Входы и выходы

| вход | по умолчанию | описание |
|------|--------------|----------|
| `token` | — | токен бота. Пустой — предупреждение, уведомление пропускается |
| `chat_id` | — | id группы (`-100…`). Пустой — как с `token` |
| `topic_id` | — | id темы (`message_thread_id`) |
| `message_id` | — | продолжить сообщение предыдущей задачи |
| `mode` | `pipeline` | `pipeline` или `release` |
| `files` | — | `release`: glob файлов, можно несколько строк; каждый до 50 МБ |
| `tag` | авто | `release`: тег. По умолчанию тег из `ref` или релиз, опубликованный этим запуском |
| `notes` | авто | `release`: заметки. По умолчанию описание релиза на GitHub, сокращённое |
| `poll_interval` | `5` | период опроса API, с (не меньше 3) |
| `github_token` | `${{ github.token }}` | чтение шагов (`actions: read`) и релизов (`contents: read`) |

| выход | описание |
|-------|----------|
| `message_id` | id сообщения. В `pipeline` его передают следующей задаче. В `release` это id сообщения о релизе |

## Как это работает

- **main** (шаг tg-notify) получает список задач запуска, отправляет беззвучное сообщение или правит
  переданное по `message_id`. Затем запускает отдельный фоновый процесс и сразу завершается.
- **Фоновый процесс** раз в `poll_interval` секунд запрашивает
  `GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs`. Сообщение правится, только если текст изменился.
  Лог процесса выводится в post-шаге в свёрнутой группе.
- **post** выполняется в конце задачи всегда (`post-if: always()`), в том числе при провале и отмене. Он
  останавливает фоновый процесс, ждёт, пока GitHub допишет статус последних шагов, и выставляет итог.
  Если упала **эта** задача, отправляется ответ со звуком.

Что показывается:

- значки шагов: ⏳ ждёт или выполняется, ✅ успех, ❌ провал или отмена; пропущенные шаги скрыты;
- скрыты служебные шаги «Set up job», «Complete job», `Post …` и сам tg-notify;
- задача, которая есть в API, но ещё не началась, выглядит как `📝 release ⏳`;
- пропущенная задача (`if` не выполнился) не показывается вовсе. Первая задача не знает заранее, будет ли
  вторая, поэтому секция задачи появляется, только когда задача появилась в API;
- итог: `✅ Готово за 4:12`, `❌ Упало: <шаг>` или `❌ Отменено`. При отмене ответ со звуком не отправляется:
  отмену запускает человек, он и так знает;
- длинный текст сокращается до лимита Telegram 4096 символов по шагам. Сначала успешные задачи сворачиваются
  в одну строку, затем скрываются успешные шаги, затем обрезаются длинные имена. Итоговая строка сохраняется.

Ограничения Telegram учтены: при обычном опросе получается не больше одной правки в 5 с, а на ответ `429`
action ждёт `retry_after`.

Заметки и ограничения:

- Сообщение «закрывает» та задача, которая завершается последней. Когда `test` закончилась, а `release` ещё
  не стартовала, шапка на время станет «✅ Сборка прошла». Задача `release` вернёт её в «⏳» и допишет свою секцию.
- Задача без шага tg-notify видна в сообщении, но итог за неё некому выставить. Добавляйте шаг в каждую задачу.
  Параллельным задачам `message_id` недоступен, поэтому каждая из них отправит своё сообщение.
- Логи в сообщение не попадают: их удобнее смотреть на GitHub по кнопке.

## Режим release

`mode: release` отправляет в тему **новое** сообщение:

```
🚀 qu1nqqy/rustos v0.1.42

## Что нового
- …
```

У сообщения кнопки «Релиз» и «Коммит», и бот **закрепляет** его в теме (в каждой теме свои закрепы).
Файлы из `files` прикладываются так:

- один файл — документом с подписью и кнопками;
- несколько — текстовое сообщение с кнопками и ответ на него альбомом документов (по 10 в альбоме);
- файл больше 50 МБ (лимит Bot API) не отправляется, в тексте будет «скачать в релизе».

Сообщение о релизе тоже беззвучное. Если закрепить не удалось (нет прав), будет предупреждение.

## Разработка

```sh
npm ci
npm test           # vitest: текст, фильтры, экранирование, обрезка, кнопки, авторы
npm run typecheck
npm run build      # ncc → dist/index.js (dist коммитится)
```

CI проверяет, что `dist` собран из текущих исходников. Переменная окружения `TELEGRAM_API_URL` задаёт свой
адрес Bot API, например локальный сервер или заглушку.

Версии: точные теги `v1.0.0`, `v1.0.1`, … и плавающий `v1`, который переносится на последний `v1.x.y`:

```sh
git tag v1.0.1 && git tag -f v1 && git push origin v1.0.1 && git push -f origin v1
```

## Лицензия

MIT
