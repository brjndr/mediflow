import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/** Messages shown in the shell banner. The value is an i18n key suffix under `notice.`. */
export type Notice = 'tenantChangedElsewhere';

export interface UiState {
  sidebarCollapsed: boolean;
  notice: Notice | null;
}

const initialState: UiState = { sidebarCollapsed: false, notice: null };

/** UI preferences held in memory. Nothing here is persisted to browser storage. */
const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
    setNotice(state, action: PayloadAction<Notice | null>) {
      state.notice = action.payload;
    },
  },
});

export const { setSidebarCollapsed, setNotice } = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
