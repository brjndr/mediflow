import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '@/shared/lib/utils';

/**
 * The tabs of the patient screen. A tab is not listed anywhere: whatever renders a `<DetailTab>`
 * inside the screen becomes one. That is how another feature adds a tab through the
 * `patient.detail.tabs` slot without this feature knowing about it.
 *
 * Tabs are listed in the order their panels sit in the page, which is the order the screen and
 * the registry put them in, whichever feature's code happens to load first.
 *
 * The open tab is in the address (`?tab=<id>`), so a tab can be linked to and survives a reload.
 * It holds the tab's id only, never anything about the patient.
 */

interface TabsValue {
  active: string | undefined;
  baseId: string;
  register: (id: string, title: string, panel: HTMLElement) => () => void;
  retitle: (id: string, title: string) => void;
}

const TabsContext = createContext<TabsValue | null>(null);

const TAB_PARAM = 'tab';
/**
 * How long a tab named in the address is waited for before the first tab is shown instead. A
 * contributed tab exists only once its feature's code has loaded, which takes a moment.
 */
const WAIT_FOR_LINKED_TAB_MS = 1500;

interface Registered {
  id: string;
  title: string;
  panel: HTMLElement;
}

/** In the order the panels are in the page. */
const byPosition = (a: Registered, b: Registered) =>
  a.panel.compareDocumentPosition(b.panel) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

export function DetailTabs({ label, children }: { label: string; children: ReactNode }) {
  const baseId = useId();
  const [tabs, setTabs] = useState<Registered[]>([]);
  const [params, setParams] = useSearchParams();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const register = useCallback((id: string, title: string, panel: HTMLElement) => {
    // An id belongs to the first tab that takes it. A second one with the same id is not listed.
    setTabs((current) =>
      current.some((tab) => tab.id === id)
        ? current
        : [...current, { id, title, panel }].sort(byPosition),
    );
    return () => setTabs((current) => current.filter((tab) => tab.panel !== panel));
  }, []);

  // In place, so a tab whose title arrives or changes (its translations loading, a change of
  // language) keeps its position.
  const retitle = useCallback((id: string, title: string) => {
    setTabs((current) =>
      current.some((tab) => tab.id === id && tab.title !== title)
        ? current.map((tab) => (tab.id === id ? { ...tab, title } : tab))
        : current,
    );
  }, []);

  const requested = params.get(TAB_PARAM);
  const known = requested !== null && tabs.some((tab) => tab.id === requested);

  // A linked tab that has not appeared yet may still be loading: show no panel for a moment
  // rather than the first tab and then a switch. An id no tab ever takes (a feature switched
  // off, a mistyped link) then falls back to the first tab.
  const [gaveUpOn, setGaveUpOn] = useState<string | null>(null);
  useEffect(() => {
    if (requested === null || known) return;
    const timer = setTimeout(() => setGaveUpOn(requested), WAIT_FOR_LINKED_TAB_MS);
    return () => clearTimeout(timer);
  }, [requested, known]);
  const waiting = requested !== null && !known && gaveUpOn !== requested;
  const active = known ? requested : waiting ? undefined : tabs[0]?.id;

  const select = (id: string) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id === tabs[0]?.id) next.delete(TAB_PARAM);
        else next.set(TAB_PARAM, id);
        return next;
      },
      { replace: true },
    );
  };

  // Arrow keys move between tabs and open them, as the tabs pattern expects.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    const target =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    select(target.id);
    buttons.current.get(target.id)?.focus();
  };

  const value = useMemo(
    () => ({ active, baseId, register, retitle }),
    [active, baseId, register, retitle],
  );
  // When no tab is open yet (a linked one is awaited), the first is the one Tab reaches.
  const focusable = active ?? tabs[0]?.id;

  return (
    <TabsContext.Provider value={value}>
      {/* Scrolls sideways inside its own box when there are more tabs than a phone has room for.
          The line under the tabs is a shadow, so it adds no height that could make it scroll
          the other way. */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the tabs are focusable, not the list */}
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={tab.id === active}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={tab.id === focusable ? 0 : -1}
            onClick={() => select(tab.id)}
            className={cn(
              // The ring is drawn inside the tab: the scrolling box would clip one outside it.
              'shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:min-h-11',
              tab.id === active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.title}
          </button>
        ))}
      </div>
      {children}
    </TabsContext.Provider>
  );
}

interface DetailTabProps {
  /**
   * Stable and unique on the screen (`details` is taken). It appears in the address, so it is a
   * plain word: never patient data.
   */
  id: string;
  /** Already translated. */
  title: string;
  /**
   * Rendered only while the tab is open. Read data in a component placed here, not in the
   * component that renders the `<DetailTab>`: that one runs every time a patient is opened.
   */
  children: ReactNode;
}

/**
 * One tab of the patient screen. Rendered by the screen itself for its own tabs, and by a
 * feature's contribution to the `patient.detail.tabs` slot.
 */
export function DetailTab({ id, title, children }: DetailTabProps) {
  const tabs = useContext(TabsContext);
  const panel = useRef<HTMLDivElement>(null);
  const register = tabs?.register;
  const retitle = tabs?.retitle;
  const firstTitle = useRef(title);

  // Registered once per id. The title is kept up to date separately, so a new title never moves
  // the tab.
  useEffect(() => {
    if (!register || !panel.current) return;
    return register(id, firstTitle.current, panel.current);
  }, [register, id]);
  useEffect(() => retitle?.(id, title), [retitle, id, title]);

  if (!tabs) return null;
  const open = tabs.active === id;
  return (
    // Always in the page, hidden while closed: its place is what orders the tabs, and the tab
    // that controls it always has something to point at.
    <div
      ref={panel}
      role="tabpanel"
      id={`${tabs.baseId}-panel-${id}`}
      aria-labelledby={`${tabs.baseId}-tab-${id}`}
      hidden={!open}
      // Reachable by keyboard even when the panel has nothing focusable in it.
      tabIndex={open ? 0 : undefined}
      className="pt-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {open ? children : null}
    </div>
  );
}
