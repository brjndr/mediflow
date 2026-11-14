# Reports (web)

What was decided for the web screen of reports (#121). The API is `apps/api/src/features/reports/CLAUDE.md`; read it first. The root rules apply.

## What exists

- **One screen,** `reports`, behind the `reports` switch, `report:read`; desktop-only (`DesktopOnly`), since a report is a wide table. Exports are `report:export` (`<Can>`), so a role with only `report:read` can show a report and open a finished export but not ask for one or download it.
- **Two ways to ask,** one form (`requestSchema`: a kind and, except for `stock`, a first and last day). "Show report" is `POST /reports/{kind}` (31 days, answered at once; more than 31 days is refused on the form's side without asking). "Export" is `POST /reports/{kind}/runs` with an `Idempotency-Key` (one key per identical body, dropped on success, so a retry after a refusal is done once).
- **Following a run** (`useRun`): asked about 1, 2, 4, 8 seconds, then every 15 (`pollDelay`), never while the tab is hidden, until `succeeded` or `failed`. Its result is cached for no time (`gcTime: 0`). The status line (`role="status"`, always on the page) says when the export the person is waiting on ends; anything said meanwhile takes the line, and a run opened from the list says nothing. The list (`useRuns`) is read every 15 seconds while any run in it is working, and once when the followed run ends.
- **Download:** `GET …/download-url` only when "Download CSV" is pressed (`useDownloadLink`, never cached); the link is a path on the API without `/api`, so `downloadAddress` resolves it against `VITE_API_BASE_URL`, and `startDownload` clicks an anchor with `download` set (the page never navigates). The link lives five minutes and is kept nowhere.
- **Errors:** the two requests a person waits on go through `apiFetchOnce` (no automatic retry of a 429, which would hold the button busy for the length of `Retry-After`); `reportErrorText` gives a sentence for `range_too_long`, `report_too_large`, `report_timeout`, `report_busy`, `report_quota` and `report_not_ready`, with the wait in seconds or minutes, else the general sentence.
- **The table** (`ReportTable`, a `DataGrid`): columns named by the server's stable keys and translated under `columns.<key>`; money is minor units through `format.money`, minutes in words, dates through `format.calendarDate`; the totals come as a last line. A report holds no patient, so nothing is masked.

- **Drill-down** (#753): on the `outstanding` table each age band has a "Show invoices" action that opens `OutstandingInvoices` under it, a `DataGrid` paged by the server (invoice number, issued, age, total, amount due; no patient, no link to the invoice). Not cached once closed (`gcTime: 0`).

## Known gaps

- English only; a new column key from the API shows as the key until `columns.<key>` is added.
- No sorting, and no chart: the reports are tables. All nine reports (#124, #691) share this one screen; text cells that are fixed words (`method`, `ageBucket`) are translated under `values.<column>.<word>`; a new kind is a locale entry, the schema list and a mock case.
- A run the person did not wait for is found in the list; nothing tells them it finished while they are elsewhere.
- The mock's download is the browser's own request to `/api/report-files/…`, which the service worker does not see, so in `pnpm dev` against the mock the file route is unanswered (the unit and Playwright tests stub or ignore it).

## Dashboard widget (#712)

`PatientFlowWidget` (`dashboard.widgets`, `report:read`, size `lg`) draws OPD visits opened in each hour of today from the `opd_hourly` report (one request, counts only), between the first and last busy hour. The admissions `CapacityWidget` (`admission:read`) reads the census bed counts; the billing `CollectedTodayWidget` (`cashRegister:read`) reads `GET /cash-registers/collected` (net by method from the payments themselves, on the hospital's clock).

## Owner panels (#690)

`VisitsTodayWidget` (`report:read`; OPD opened and closed today, `opd_census` for the hospital's day) and `UnpaidInvoicesWidget` (`report:read` and `invoice:read`; count and amount due from the `outstanding` snapshot, linking to `/billing/invoices?status=issued`) sit beside `PatientFlowWidget`. No new endpoint: the reports API already gives these. `invoice:read` is listed in this manifest's permissions only so the widget can require it. "Collected today" is the billing `CollectedTodayWidget` (`cashRegister:read`, payments net of refunds from `GET /cash-registers/collected`, #817). `InvoiceList` starts its status filter from `?status=` (the status is not patient data).
