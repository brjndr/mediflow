/** Where and how a hospital wants values shown. Comes from the tenant config, never hardcoded. */
export interface FormatConfig {
  /** BCP 47 locale. */
  locale: string;
  /** IANA timezone. */
  timezone: string;
  /** ISO 4217 currency code. Without one, money is shown as a plain number. */
  currency?: string;
}

/** An ISO string (UTC), a Date, or epoch milliseconds. */
export type DateInput = string | Date | number;

export interface Formatters {
  /** Calendar date in the hospital's timezone. */
  date(value: DateInput): string;
  /** Time of day in the hospital's timezone. */
  time(value: DateInput): string;
  dateTime(value: DateInput): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /**
   * An amount held in minor units (paise, fils, cents), which is how money is stored and sent.
   * The number of decimals comes from the currency itself.
   */
  money(minorUnits: number): string;
}

/** Used when there is no hospital, or its config names something the browser does not know. */
export const FALLBACK_FORMAT: FormatConfig = { locale: 'en', timezone: 'UTC' };

function supported<T>(build: () => T): T | undefined {
  try {
    return build();
  } catch {
    // Intl throws RangeError for an unknown locale, timezone or currency.
    return undefined;
  }
}

function build(config: FormatConfig): Formatters {
  // Each part of a bad config falls back on its own, so one wrong value does not lose the rest.
  const locale =
    supported(() => Intl.getCanonicalLocales(config.locale)[0]) ?? FALLBACK_FORMAT.locale;
  const timeZone =
    supported(
      () =>
        new Intl.DateTimeFormat(locale, { timeZone: config.timezone }).resolvedOptions().timeZone,
    ) ?? FALLBACK_FORMAT.timezone;

  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone });
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone });
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const plain = new Intl.NumberFormat(locale);
  const currency = config.currency;
  const money =
    (currency && supported(() => new Intl.NumberFormat(locale, { style: 'currency', currency }))) ||
    new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const minorPerMajor = 10 ** (money.resolvedOptions().maximumFractionDigits ?? 2);

  return {
    date: (value) => date.format(new Date(value)),
    time: (value) => time.format(new Date(value)),
    dateTime: (value) => dateTime.format(new Date(value)),
    number: (value, options) =>
      options ? new Intl.NumberFormat(locale, options).format(value) : plain.format(value),
    money: (minorUnits) => money.format(minorUnits / minorPerMajor),
  };
}

// Intl objects are costly to create. They depend only on the config, so they are safe to share.
const cache = new Map<string, Formatters>();

/** Formatters for one hospital's config. Format only at the display layer. */
export function createFormatters(config: FormatConfig = FALLBACK_FORMAT): Formatters {
  const key = `${config.locale}|${config.timezone}|${config.currency ?? ''}`;
  let formatters = cache.get(key);
  if (!formatters) {
    formatters = build(config);
    cache.set(key, formatters);
  }
  return formatters;
}
