import {
  combineReducers,
  configureStore,
  createAction,
  type UnknownAction,
} from '@reduxjs/toolkit';
import { uiReducer } from './ui-slice';

/**
 * Dispatched on tenant switch and logout. The root reducer drops the whole state, so every slice
 * returns to its initial state without having to handle the action itself.
 */
export const resetClientState = createAction('app/resetClientState');

// Client and workflow state only. Server data (session, tenant config, policy) stays in React Query.
const appReducer = combineReducers({ ui: uiReducer });

export type RootState = ReturnType<typeof appReducer>;

function rootReducer(state: RootState | undefined, action: UnknownAction): RootState {
  return appReducer(resetClientState.match(action) ? undefined : state, action);
}

export function createStore() {
  return configureStore({ reducer: rootReducer });
}

export type AppStore = ReturnType<typeof createStore>;
export type AppDispatch = AppStore['dispatch'];
