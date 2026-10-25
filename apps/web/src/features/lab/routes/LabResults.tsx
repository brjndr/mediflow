import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { AmendResult } from '../components/AmendResult';
import { ResultEntry } from '../components/ResultEntry';
import { ResultFlag } from '../components/ResultFlag';
import { rangeWords } from '../range-words';
import { VerifyResults } from '../components/VerifyResults';
import { useOrderResults } from '../hooks/use-lab';
import type { LabAnalyte, LabOrderResults, LabResult } from '../types';

/** One line of the results: a test, its current result, and whether it waits for verifying. */
interface ResultLine {
  labTestId: string;
  name: string;
  unit?: string;
  analyte?: LabAnalyte;
  current?: LabResult;
  /** Held back from this reader until verified (a doctor). */
  awaiting: boolean;
}

/**
 * The tests of the order in the catalog's order, then any current result of a test no longer in
 * it (a panel changed since), so no result is ever left out.
 */
function linesOf(data: LabOrderResults): ResultLine[] {
  const current = data.results.filter((result) => result.amendedById === undefined);
  const awaiting = new Set(data.awaitingVerification ?? []);
  const lines: ResultLine[] = data.analytes.map((analyte) => ({
    labTestId: analyte.labTestId,
    name: analyte.name,
    ...(analyte.unit ? { unit: analyte.unit } : {}),
    analyte,
    current: current.find((result) => result.labTestId === analyte.labTestId),
    awaiting: awaiting.has(analyte.labTestId),
  }));
  for (const result of current) {
    if (!lines.some((line) => line.labTestId === result.labTestId)) {
      lines.push({
        labTestId: result.labTestId,
        name: result.testName,
        ...(result.unit ? { unit: result.unit } : {}),
        current: result,
        awaiting: false,
      });
    }
  }
  return lines;
}

/**
 * A lab order's results (`lab/orders/:orderId`, #91, for `labResult:read`). The laboratory
 * enters results of a received sample (`labResult:enter`), verifies them (`labResult:verify`)
 * and corrects one with a reason, which the history keeps (`labResult:enter`). The flags are the
 * API's. A reader who may neither enter nor verify (a doctor) is given verified results only: a
 * result still to verify says so and shows no value, so it is never read as final. Works at
 * every width, with one column of fields on a phone.
 */
export default function LabResults() {
  const { orderId = '' } = useParams();
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canEnter = usePermission('labResult:enter');
  const canVerify = usePermission('labResult:verify');
  const query = useOrderResults(orderId);

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  const [amending, setAmending] = useState<LabResult | null>(null);
  usePanelFocus(amending ? `amend:${amending.id}` : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const data = query.data;
  const lines = useMemo(() => (data ? linesOf(data) : []), [data]);

  const columns = useMemo<GridColumn<ResultLine>[]>(() => {
    const number = (value: number) => format.number(value);
    return [
      {
        id: 'test',
        header: t('results.columns.test'),
        value: (line) => line.name,
        hideable: false,
      },
      {
        id: 'result',
        header: t('results.columns.result'),
        value: (line) =>
          line.current
            ? [line.current.value, line.current.unit].filter(Boolean).join(' ')
            : line.awaiting
              ? t('results.awaiting')
              : t('results.none'),
        render: (line) =>
          line.current ? (
            <span className="font-medium whitespace-pre-line">
              {[line.current.value, line.current.unit].filter(Boolean).join(' ')}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {line.awaiting ? t('results.awaiting') : t('results.none')}
            </span>
          ),
      },
      {
        id: 'flag',
        header: t('results.columns.flag'),
        value: (line) => (line.current?.flag ? t(`flag.${line.current.flag}`) : ''),
        render: (line) => <ResultFlag flag={line.current?.flag} />,
      },
      {
        id: 'range',
        header: t('results.columns.range'),
        value: (line) => rangeWords(line.current?.range ?? line.analyte?.range, t, number),
      },
      {
        id: 'state',
        header: t('results.columns.state'),
        value: (line) => {
          const result = line.current;
          if (!result) return line.awaiting ? t('results.notVerified') : '';
          return result.status === 'verified'
            ? t('results.verifiedBy', {
                name: result.verifiedByName ?? '',
                time: result.verifiedAt ? format.dateTime(result.verifiedAt) : '',
              })
            : t('results.enteredBy', {
                name: result.enteredByName,
                time: format.dateTime(result.enteredAt),
              });
        },
        render: (line) => {
          const result = line.current;
          if (result?.status === 'entered' || (!result && line.awaiting)) {
            return (
              <span className="font-semibold">
                {t('results.notVerified')}
                {result && (
                  <span className="block font-normal text-muted-foreground">
                    {t('results.enteredBy', {
                      name: result.enteredByName,
                      time: format.dateTime(result.enteredAt),
                    })}
                  </span>
                )}
              </span>
            );
          }
          return result
            ? t('results.verifiedBy', {
                name: result.verifiedByName ?? '',
                time: result.verifiedAt ? format.dateTime(result.verifiedAt) : '',
              })
            : '';
        },
      },
      {
        id: 'comment',
        header: t('results.columns.comment'),
        value: (line) => line.current?.comment ?? '',
      },
    ];
  }, [t, format]);

  if (query.isPending) return <PageSkeleton label={t('results.loading')} />;
  if (query.isError || !data) {
    const missing = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('results.title')}</h1>
        <p role="alert" className="text-sm">
          {missing ? t('results.notFound') : tCommon(errorMessageKey(query.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!missing && (
            <Button type="button" variant="outline" onClick={() => void query.refetch()}>
              {t('results.retry')}
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/lab">{t('results.back')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const sample = data.sample;
  const open = data.orderStatus !== 'cancelled' && data.orderStatus !== 'completed';
  const toEnter = lines.flatMap((line) => (line.analyte && !line.current ? [line.analyte] : []));
  const toVerify = lines.flatMap((line) =>
    line.current?.status === 'entered' ? [line.current] : [],
  );
  const history = data.results.filter((result) => result.amendedById !== undefined);
  const showEntry = canEnter && sample?.status === 'received' && open && toEnter.length > 0;
  const showVerify =
    canVerify && sample !== undefined && data.orderStatus !== 'cancelled' && toVerify.length > 0;

  const actions: GridAction<ResultLine>[] = [
    {
      id: 'amend',
      label: t('results.correct'),
      requires: 'labResult:enter',
      disabled: (line) => !line.current || data.orderStatus === 'cancelled',
      onSelect: (line) => {
        if (line.current && data.orderStatus !== 'cancelled') setAmending(line.current);
      },
    },
  ];

  /** Where the sample is, when it has no results to show yet. */
  const sampleWords = !sample
    ? t('results.noSample')
    : sample.status === 'collected'
      ? t('results.notReceived', { id: sample.accessionId })
      : '';

  const saved = (answer: LabOrderResults, entered: string[]) => {
    const critical = answer.results.filter(
      (result) =>
        entered.includes(result.labTestId) &&
        result.amendedById === undefined &&
        (result.flag === 'critical_low' || result.flag === 'critical_high'),
    );
    say(
      [
        t('results.saved', { count: entered.length }),
        critical.length > 0
          ? t('results.criticalSaved', { names: critical.map((each) => each.testName).join(', ') })
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  return (
    <div ref={box} className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('results.heading', { test: data.itemName })}
        </h1>
        <Button asChild variant="outline">
          <Link to="/lab">{t('results.back')}</Link>
        </Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">{t('results.patient')}</dt>
          <dd className="font-medium">{data.patientName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('results.mrn')}</dt>
          <dd>{maskMrn(data.patientMrn)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('results.sample')}</dt>
          <dd>
            {sample
              ? t('results.sampleOf', {
                  id: sample.accessionId,
                  sample: t(`sampleType.${sample.sampleType}`),
                  time: format.dateTime(sample.collectedAt),
                })
              : t('results.noSample')}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('results.orderState')}</dt>
          <dd>
            {t('results.orderStateValue', {
              priority: t(`priority.${data.priority}`),
              status: t(`orderStatus.${data.orderStatus}`),
            })}
          </dd>
        </div>
      </dl>
      {/* Always on the page, so what was done is read when it is said. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none empty:-mt-4 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {/* A new node per message, so the same words said twice are announced twice. */}
        {message.text && <span key={message.count}>{message.text}</span>}
      </p>
      {sampleWords && <p className="text-sm text-muted-foreground">{sampleWords}</p>}
      {amending && (
        <AmendResult
          key={amending.id}
          result={amending}
          onClose={() => setAmending(null)}
          onAmended={(amended) => {
            setAmending(null);
            say(t('amend.done', { name: amended.testName }));
          }}
        />
      )}
      <DataGrid
        label={t('results.listLabel', { test: data.itemName })}
        columns={columns}
        rows={lines}
        rowId={(line) => line.labTestId}
        rowLabel={(line) => line.name}
        actions={actions}
        status="ready"
        emptyMessage={t('results.empty')}
      />
      {showVerify && (
        <VerifyResults
          key={toVerify.map((result) => result.id).join()}
          sample={sample}
          results={toVerify}
          onRefused={say}
          onVerified={(answer, count) =>
            say(
              answer.orderStatus === 'completed' && data.orderStatus !== 'completed'
                ? t('verify.doneCompleted', { count })
                : t('verify.done', { count }),
            )
          }
        />
      )}
      {showEntry && (
        <ResultEntry
          key={sample.id}
          sample={sample}
          analytes={toEnter}
          onSaved={saved}
          onRefused={say}
        />
      )}
      {history.length > 0 && (
        <section aria-labelledby="lab-results-history" className="flex flex-col gap-2">
          <h2 id="lab-results-history" className="font-semibold">
            {t('results.history')}
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((result) => (
              <li key={result.id} className="rounded-md border p-3">
                <p className="font-medium">
                  {t('results.replaced', {
                    name: result.testName,
                    value: [result.value, result.unit].filter(Boolean).join(' '),
                  })}{' '}
                  <ResultFlag flag={result.flag} />
                </p>
                <p className="text-muted-foreground">
                  {t('results.enteredBy', {
                    name: result.enteredByName,
                    time: format.dateTime(result.enteredAt),
                  })}
                </p>
                {result.verifiedByName && (
                  <p className="text-muted-foreground">
                    {t('results.verifiedBy', {
                      name: result.verifiedByName,
                      time: result.verifiedAt ? format.dateTime(result.verifiedAt) : '',
                    })}
                  </p>
                )}
                {correctionOf(data, result) && (
                  <p>{t('results.reason', { reason: correctionOf(data, result) })}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The reason given by the correction that replaced a result, when this reader has it. */
function correctionOf(data: LabOrderResults, result: LabResult): string | undefined {
  return data.results.find((each) => each.id === result.amendedById)?.amendmentReason;
}
