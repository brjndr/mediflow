import { createStore, resetClientState } from './store';
import { setSidebarCollapsed } from './ui-slice';

describe('store', () => {
  it('holds client state per store instance', () => {
    const a = createStore();
    const b = createStore();
    a.dispatch(setSidebarCollapsed(true));
    expect(a.getState().ui.sidebarCollapsed).toBe(true);
    expect(b.getState().ui.sidebarCollapsed).toBe(false);
  });

  it('returns every slice to its initial state on resetClientState', () => {
    const store = createStore();
    const initial = store.getState();
    store.dispatch(setSidebarCollapsed(true));
    store.dispatch(resetClientState());
    expect(store.getState()).toEqual(initial);
  });
});
