export const SHORTCUTS: Array<{ keys: string; label: string; scope: string }> =
  [
    { keys: 'G then D', label: 'Go to dashboard', scope: 'Global' },
    { keys: 'G then P', label: 'Go to patients', scope: 'Global' },
    { keys: 'G then A', label: 'Go to appointments', scope: 'Global' },
    { keys: 'G then R', label: 'Go to lab records', scope: 'Global' },
    { keys: 'G then C', label: 'Open the AI assistant page', scope: 'Global' },
    { keys: '?', label: 'Show / hide this help', scope: 'Global' },
    { keys: 'Shift + D', label: 'Toggle compact density', scope: 'Global' },
    { keys: '/', label: 'Focus the search box', scope: 'Patients, Records' },
    { keys: 'N', label: 'New patient', scope: 'Patients' },
    { keys: 'Esc', label: 'Close dialogs', scope: 'Global' },
  ]
