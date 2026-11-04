# Reports (web)

What was decided for the web screen of reports (#121). The API is `apps/api/src/features/reports/CLAUDE.md`; read it first. The root rules apply.

## What exists

- **One screen,** `reports`, behind the `reports` switch, `report:read`; desktop-only (`DesktopOnly`), since a report is a wide table. Exports are `report:export` (`<Can>`), so a role with only `report:read` can show a report and open a finished export but not ask for one or download it.
- **Two ways to ask,** one form (`requestSchema`: a kind and, except for `stock`, a first and last day). "Show report" is `POST /reports/{kind}` (31 days, answered at once; more than 31 days is refused on the form's side without asking). "Export" is `POST /reports/{kind}/runs` with an `Idempotency-Key` (one key per identical body, dropped on success, so a retry after a refusal is done once).
- **Following a run** (`useRun`): asked about 1, 2, 4, 8 seconds, then every 15 (`pollDelay`), never while the tab is hidden, until `succeeded` or `failed`. Its result is cached for no time (`gcTime: 0`). The status line (`role="status"`, always on the page) says when the export the person is waiting on ends; anything said meanwhile takes the line, and a run opened from the list says nothing. The list (`useRuns`) is read every 15 seconds while any run in it is working, and once when the followed run ends.
- **Download:** `GET …/download-url` only when "Download CSV" is pressed (`useDownloadLink`, never cached); the link is a path on the API without `/api`, so `downloadAddress` resolves it against `VITE_API_BASE_URL`, and `startDownload` clicks an anchor with `download` set (the page never navigates). The link lives five minutes and is kept nowhere.
- **Errors:** the two requests a person waits on go through `apiFetchOnce` (no automatic retry of a 429, which would hold the button busy for the length of `Retry-After`); `reportErrorText` gives a sentence for `range_too_long`, `report_too_large`, `report_timeout`, `report_busy`, `report_quota` and `report_not_ready`, with the wait in seconds or minutes, else the general sentence.
- **The table** (`ReportTable`, a `DataGrid`): columns named by the server's stable keys and translated under `columns.<key>`; money is minor units through `format.money`, minutes in words, dates through `format.calendarDate`; the totals come as a last line. A report holds no patient, so nothing is masked.

## Known gaps

- English only; a new column key from the API shows as the key until `columns.<key>` is added.
- No sorting, and no chart: the four reports are tables. Per-report screens and the doctor-wise and pharmacy-sales reports are #124.
- A run the person did not wait for is found in the list; nothing tells them it finished while they are elsewhere.
- The mock's download is the browser's own request to `/api/report-files/…`, which the service worker does not see, so in `pnpm dev` against the mock the file route is unanswered (the unit and Playwright tests stub or ignore it).
