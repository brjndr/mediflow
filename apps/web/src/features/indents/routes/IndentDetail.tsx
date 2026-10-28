import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { useSession } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button, buttonVariants } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { useFormatters } from '@/tenancy';
import { ApprovePanel } from '../components/ApprovePanel';
import { EndPanel } from '../components/EndPanel';
import { IssuePanel } from '../components/IssuePanel';
import { IssueVoucher } from '../components/IssueVoucher';
import { INDENT_REFUSED } from '../components/refusals';
import { useIndent, useStepIndent } from '../hooks/use-indents';
import { useItemName } from '../hooks/use-item-name';
import type { StockIndent, StockIndentLine, StockIssue } from '../types';

type Panel = 'approve' | 'reject' | 'issue' | 'close';

/**
 * An indent (`inventory/indents/:indentId`, #105), for `indent:read`: the place that asked and
 * the store asked, its steps with who and when, its lines with what was asked, approved and
 * issued of each and the store's stock, and its vouchers, each printable. By its step:
 * **Approve** and **Reject** a requested one (`indent:approve`, `aria-disabled` on one's own),
 * **Withdraw** one's own before it is decided (`indent:create`), **Issue** and **Close** an
 * approved one (`indent:issue`). Works at every width.
 */
export default function IndentDetail() {
  const { indentId = '' } = useParams();
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const nameOf = useItemName();
  const location = useLocation();
  const me = useSession()?.user.id;
  const indent = useIndent(indentId);
  const data = indent.data;
  const canCreate = usePermission('indent:create');
  const canApprove = usePermission('indent:approve');
  const canIssue = usePermission('indent:issue');
  const ownId = useId();
  const vouchersId = useId();

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  // Arriving from the form that saved it, it says so.
  const saved = (location.state as { saved?: boolean } | null)?.saved === true;
  const [message, setMessage] = useState({ text: saved ? t('detail.saved') : '', count: 0 });
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);
  const [panel, setPanel] = useState<Panel | null>(null);
  usePanelFocus(panel, box, status);
  const [printing, setPrinting] = useState<{ issue: StockIssue; count: number } | null>(null);

  const step = useStepIndent();
  const stepFailure = step.error
    ? isApiError(step.error) && INDENT_REFUSED[step.error.serverCode ?? '']
      ? t(INDENT_REFUSED[step.error.serverCode ?? ''] ?? '')
      : tCommon(errorMessageKey(step.error))
    : undefined;

  const columns = useMemo<GridColumn<StockIndentLine>[]>(
    () => [
      {
        id: 'item',
        header: t('detail.columns.item'),
        value: (row) => nameOf(row.item),
        hideable: false,
      },
      {
        id: 'asked',
        header: t('detail.columns.asked'),
        value: (row) => t('units', { count: row.requestedQuantity }),
      },
      {
        id: 'approved',
        header: t('detail.columns.approved'),
        value: (row) =>
          row.approvedQuantity === undefined
            ? t('detail.notYet')
            : t('units', { count: row.approvedQuantity }),
      },
      {
        id: 'issued',
        header: t('detail.columns.issued'),
        value: (row) => t('units', { count: row.issuedQuantity }),
      },
      {
        id: 'store',
        header: t('detail.columns.store'),
        value: (row) =>
          row.storeOnHand === undefined ? '' : t('units', { count: row.storeOnHand }),
      },
    ],
    [t, nameOf],
  );

  if (indent.isPending) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{t('detail.loading')}</p>;
  }
  if (!data) {
    const gone = isApiError(indent.error) && indent.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('detail.heading')}</h1>
        <p role="alert" className="text-sm text-destructive">
          {gone ? t('detail.notFound') : tCommon(errorMessageKey(indent.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!gone && (
            <Button type="button" onClick={() => void indent.refetch()}>
              {t('retry')}
            </Button>
          )}
          <Link to="/inventory/indents" className={buttonVariants({ variant: 'outline' })}>
            {t('detail.back')}
          </Link>
        </div>
      </div>
    );
  }

  // Whoever asked for it does not decide it (the API refuses it too).
  const own = me !== undefined && data.requestedById === me;
  const open = data.status === 'approved' || data.status === 'partly_issued';
  // A panel opened starts afresh: an earlier step's refusal no longer stands beside it.
  const openPanel = (next: Panel) => {
    step.reset();
    setPanel(next);
  };
  const done = (key: string) => (moved: StockIndent) => {
    setPanel(null);
    say(t(key, { reference: moved.reference }));
  };
  const withdraw = () => {
    if (step.isPending) return;
    step.reset();
    step.mutate(
      { indent: data, change: { step: 'cancel' } },
      {
        onSuccess: done('detail.withdrawn'),
        onError: () => focusIfLost(status.current),
      },
    );
  };
  const nameOfLine = (lineId: string) => {
    const line = data.lines.find((each) => each.id === lineId);
    return line ? nameOf(line.item) : '';
  };

  return (
    <div ref={box} className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('detail.headingOf', { reference: data.reference })}
        </h1>
        <Link
          to="/inventory/indents"
          className="text-sm font-medium text-muted-foreground underline underline-offset-4"
        >
          {t('detail.back')}
        </Link>
      </div>
      <p
        ref={status}
        role="status"
        tabIndex={-1}
        className="text-sm text-muted-foreground outline-none"
      >
        {message.text}
      </p>
      {stepFailure && (
        <p role="alert" className="text-sm text-destructive">
          {stepFailure}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-[auto_1fr]">
        <dt className="font-medium">{t('detail.status')}</dt>
        <dd>{t(`status.${data.status}`)}</dd>
        <dt className="font-medium">{t('detail.from')}</dt>
        <dd>{data.fromLocationName}</dd>
        <dt className="font-medium">{t('detail.to')}</dt>
        <dd>{data.toLocationName}</dd>
        <dt className="font-medium">{t('detail.asked')}</dt>
        <dd>{t('by', { name: data.requestedByName, time: format.dateTime(data.requestedAt) })}</dd>
        {data.decidedAt && (
          <>
            <dt className="font-medium">
              {t(data.status === 'rejected' ? 'detail.rejected' : 'detail.approved')}
            </dt>
            <dd>
              {t('by', { name: data.decidedByName ?? '', time: format.dateTime(data.decidedAt) })}
            </dd>
          </>
        )}
        {data.rejectionNote && (
          <>
            <dt className="font-medium">{t('detail.why')}</dt>
            <dd className="break-words">{data.rejectionNote}</dd>
          </>
        )}
        {data.endedAt && (
          <>
            <dt className="font-medium">{t(`status.${data.status}`)}</dt>
            <dd>
              {t('by', { name: data.endedByName ?? '', time: format.dateTime(data.endedAt) })}
            </dd>
          </>
        )}
        {data.endNote && (
          <>
            <dt className="font-medium">{t('detail.why')}</dt>
            <dd className="break-words">{data.endNote}</dd>
          </>
        )}
        {data.note && (
          <>
            <dt className="font-medium">{t('detail.note')}</dt>
            <dd className="break-words">{data.note}</dd>
          </>
        )}
      </dl>
      {!panel && (
        <div className="flex flex-wrap gap-2">
          {data.status === 'requested' && canApprove && (
            <>
              <Button
                type="button"
                aria-disabled={own || undefined}
                aria-describedby={own ? ownId : undefined}
                onClick={() => {
                  if (!own) openPanel('approve');
                }}
              >
                {t('detail.approve')}
              </Button>
              <Button
                type="button"
                variant="outline"
                aria-disabled={own || undefined}
                aria-describedby={own ? ownId : undefined}
                onClick={() => {
                  if (!own) openPanel('reject');
                }}
              >
                {t('detail.reject')}
              </Button>
            </>
          )}
          {data.status === 'requested' && canCreate && own && (
            <Button
              type="button"
              variant="outline"
              aria-disabled={step.isPending || undefined}
              onClick={withdraw}
            >
              {t('detail.withdraw')}
            </Button>
          )}
          {open && canIssue && (
            <>
              <Button type="button" onClick={() => openPanel('issue')}>
                {t('detail.issue')}
              </Button>
              <Button type="button" variant="outline" onClick={() => openPanel('close')}>
                {t('detail.close')}
              </Button>
            </>
          )}
        </div>
      )}
      {data.status === 'requested' && canApprove && own && (
        <p id={ownId} className="text-sm text-muted-foreground">
          {t('detail.ownHint')}
        </p>
      )}
      {panel === 'approve' && canApprove && (
        <ApprovePanel
          indent={data}
          onClose={() => setPanel(null)}
          onApproved={done('detail.approvedDone')}
        />
      )}
      {(panel === 'reject' || panel === 'close') && (
        <EndPanel
          indent={data}
          step={panel}
          onClose={() => setPanel(null)}
          onDone={done(panel === 'reject' ? 'detail.rejectedDone' : 'detail.closedDone')}
        />
      )}
      {panel === 'issue' && canIssue && open && (
        <IssuePanel
          indent={data}
          onClose={() => setPanel(null)}
          onIssued={(moved) => {
            setPanel(null);
            say(
              t('detail.issuedDone', {
                reference: moved.issues.at(-1)?.reference ?? '',
                indent: moved.reference,
              }),
            );
          }}
        />
      )}
      <DataGrid
        label={t('detail.lines')}
        // The store's stock is given to whoever approves or issues only.
        columns={
          data.lines.some((line) => line.storeOnHand !== undefined)
            ? columns
            : columns.filter((column) => column.id !== 'store')
        }
        rows={data.lines}
        rowId={(row) => row.id}
        rowLabel={(row) => nameOf(row.item)}
        status="ready"
        emptyMessage={t('detail.noLines')}
      />
      <section aria-labelledby={vouchersId} className="flex flex-col gap-2">
        <h2 id={vouchersId} className="text-lg font-semibold">
          {t('detail.vouchers')}
        </h2>
        {data.issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('detail.noVouchers')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.issues.map((issue) => (
              <li key={issue.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">
                    {t('detail.voucherHeading', {
                      reference: issue.reference,
                      name: issue.issuedByName,
                      time: format.dateTime(issue.issuedAt),
                    })}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('detail.printVoucherOf', { reference: issue.reference })}
                    onClick={() => setPrinting((now) => ({ issue, count: (now?.count ?? 0) + 1 }))}
                  >
                    {t('detail.printVoucher')}
                  </Button>
                </div>
                <ul className="list-disc pl-5 text-sm">
                  {issue.lines.map((line) => (
                    <li key={`${line.indentLineId}:${line.batchId}`}>
                      {t('detail.voucherLine', {
                        name: nameOfLine(line.indentLineId),
                        number: line.batchNumber,
                        expiry: format.calendarDate(line.expiryDate),
                        count: line.quantity,
                      })}
                    </li>
                  ))}
                </ul>
                {issue.note && <p className="break-words text-sm">{issue.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      {printing && (
        <PrintSheet key={`${printing.issue.id}:${printing.count}`} onDone={() => setPrinting(null)}>
          <IssueVoucher indent={data} issue={printing.issue} />
        </PrintSheet>
      )}
    </div>
  );
}
