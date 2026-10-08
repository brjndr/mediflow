import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

// Isomorphic tool *definitions*. Server implementations live in
// src/routes/demo/api.ai.chat.ts so repository code never reaches the client.

export const getHospitalStatsToolDef = toolDefinition({
  name: 'getHospitalStats',
  description:
    'Get current hospital statistics: patient counts by status and ward, and appointment counts.',
  inputSchema: z.object({}),
})

export const searchPatientsToolDef = toolDefinition({
  name: 'searchPatients',
  description:
    'Search patients by name, MRN, ward, status or condition. Returns at most 8 matches.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('Free-text search, e.g. "cardiology" or "Smith"'),
  }),
})

export const showPatientCardToolDef = toolDefinition({
  name: 'showPatientCard',
  description:
    'REQUIRED to present a specific patient to the user. Renders a patient card in the chat with a link to the chart. Use the id returned by searchPatients.',
  inputSchema: z.object({
    id: z.string().describe('Patient id from searchPatients'),
  }),
  outputSchema: z.object({ id: z.string() }),
})
