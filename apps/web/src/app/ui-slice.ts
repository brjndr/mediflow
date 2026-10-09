import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface UiState {
  sidebarCollapsed: boolean;
}

const initialState: UiState = { sidebarCollapsed: false };

/** UI preferences held in memory. Nothing here is persisted to browser storage. */
const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
  },
});

export const { setSidebarCollapsed } = uiSlice.actions;
export const uiReducer = uiSlice.reducer;
