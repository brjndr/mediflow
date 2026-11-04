import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ServiceSearch, type ServiceOption } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { usePackageContents, useSetPackageContents } from '../hooks/use-billing';
import { refusalText } from '../lib/panel-helpers';
import type { PackageItem } from '../types';

const LINK =
  'inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
const REFUSALS = new Set(['invalid_package_item', 'not_a_package', 'service_not_found']);
/** The most a package holds, as the API allows. */
const ITEMS_MAX = 100;

/**
 * What a package includes and what it leaves to be billed separately (`billing/packages`, #117),
 * for `package:manage`. Choose a package of the price catalog, then add services to it as
 * included (covered by its price) or excluded (always billed on its own), and save: the whole
 * contents are replaced. A package already applied to a visit is not changed by this.
 */
export default function Packages() {
  const { t } = useTranslation('billing');
  const [chosen, setChosen] = useState<ServiceOption | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('packages.heading')}</h1>
        <p className="text-muted-foreground">{t('packages.description')}</p>
        <Link to="/billing/invoices" className={LINK}>
          {t('packages.back')}
        </Link>
      </div>
      <ServiceSearch category="package" label={t('packages.choose')} onSelect={setChosen} />
      {chosen ? (
        <Editor key={chosen.id} service={chosen} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('packages.none')}</p>
      )}
    </div>
  );
}

function Editor({ service }: { service: ServiceOption }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const contents = usePackageContents(service.id);

  return (
    <section aria-labelledby="package-contents-heading" className="flex flex-col gap-3">
      <h2 id="package-contents-heading" className="text-lg font-semibold">
        {t('packages.contentsOf', { name: service.name })}
      </h2>
      {contents.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : contents.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(contents.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void contents.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <ContentsForm serviceId={service.id} saved={contents.data.items} />
      )}
    </section>
  );
}

function ContentsForm({ serviceId, saved }: { serviceId: string; saved: PackageItem[] }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const save = useSetPackageContents(serviceId);
  const [items, setItems] = useState<PackageItem[]>(saved);
  const [pick, setPick] = useState<ServiceOption | null>(null);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  function add(kind: PackageItem['kind']) {
    if (!pick) return;
    setMessage(null);
    if (pick.id === serviceId || items.some((item) => item.serviceId === pick.id)) {
      setMessage({ text: t('packages.already'), failed: true });
      return;
    }
    if (items.length >= ITEMS_MAX) {
      setMessage({ text: t('packages.tooMany', { count: ITEMS_MAX }), failed: true });
      return;
    }
    setItems([...items, { serviceId: pick.id, code: pick.code, name: pick.name, kind }]);
    setPick(null);
  }

  async function submit() {
    setMessage(null);
    try {
      const done = await save.mutateAsync(
        items.map(({ serviceId: id, kind }) => ({ serviceId: id, kind })),
      );
      setItems(done.items);
      setMessage({ text: t('packages.saved'), failed: false });
    } catch (error) {
      setMessage({ text: refusalText(error, REFUSALS, 'packages', t, tCommon), failed: true });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {(['included', 'excluded'] as const).map((kind) => {
        const rows = items.filter((item) => item.kind === kind);
        return (
          <div key={kind} className="flex flex-col gap-2">
            <h3 className="font-medium">{t(`packages.kind.${kind}`)}</h3>
            <p className="text-sm text-muted-foreground">{t(`packages.kindHint.${kind}`)}</p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('packages.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {rows.map((item) => (
                  <li key={item.serviceId} className="flex items-center justify-between gap-2">
                    <span>
                      {item.name} <span className="text-muted-foreground">({item.code})</span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      aria-label={t('packages.remove', { name: item.name })}
                      onClick={() => {
                        setItems(items.filter((each) => each.serviceId !== item.serviceId));
                        setMessage(null);
                      }}
                    >
                      {t('packages.removeShort')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      <div className="flex flex-col gap-2">
        <ServiceSearch label={t('packages.addService')} onSelect={setPick} />
        {pick && (
          <p className="text-sm font-medium" data-testid="picked-service">
            {t('addCharge.chosen', { name: pick.name })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-disabled={!pick}
            onClick={() => add('included')}
          >
            {t('packages.addIncluded')}
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-disabled={!pick}
            onClick={() => add('excluded')}
          >
            {t('packages.addExcluded')}
          </Button>
        </div>
      </div>

      <div>
        <Button
          type="button"
          aria-disabled={save.isPending}
          onClick={() => {
            if (!save.isPending) void submit();
          }}
        >
          {save.isPending ? t('packages.saving') : t('packages.submit')}
        </Button>
      </div>
      {/* Always on the page, so a saved or refused change is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>
    </div>
  );
}
