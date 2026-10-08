import { createFileRoute } from '@tanstack/react-router'
import { chat, maxIterations, toServerSentEventsResponse } from '@tanstack/ai'
import { anthropicText } from '@tanstack/ai-anthropic'
import { openaiText } from '@tanstack/ai-openai'
import { geminiText } from '@tanstack/ai-gemini'
import { ollamaText } from '@tanstack/ai-ollama'

import {
  getHospitalStatsToolDef,
  searchPatientsToolDef,
  showPatientCardToolDef,
} from '#/lib/hospital-ai-tools'
import { fullName } from '#/lib/hospital/schemas'
import { computeStats, getRepo } from '#/server/hospital-repo.server'

const getHospitalStats = getHospitalStatsToolDef.server(() => computeStats())

const searchPatients = searchPatientsToolDef.server(async ({ query }) => {
  const q = query.toLowerCase()
  const patients = await (await getRepo()).listPatients()
  return patients
    .filter((p) =>
      [fullName(p), p.mrn, p.ward, p.status, p.condition]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      name: fullName(p),
      mrn: p.mrn,
      ward: p.ward,
      status: p.status,
      condition: p.condition,
    }))
})

const SYSTEM_PROMPT = `You are MediFlow Assistant, an operations assistant for hospital staff.

WORKFLOW:
- For questions about census, wards or appointment load, call getHospitalStats and summarise.
- To find patients, call searchPatients. Never invent patients.
- To present a specific patient, ALWAYS call showPatientCard with the id from searchPatients instead of describing them yourself.

You provide operational information only. Never give medical diagnoses or treatment advice; tell staff to consult a clinician.
`

export const Route = createFileRoute('/demo/api/ai/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Capture request signal before reading body (it may be aborted after body is consumed)
        const requestSignal = request.signal

        // If request is already aborted, return early
        if (requestSignal.aborted) {
          return new Response(null, { status: 499 }) // 499 = Client Closed Request
        }

        const abortController = new AbortController()

        try {
          const body = await request.json()
          const { messages } = body

          // Determine the best available provider
          let provider = 'ollama'
          let model = 'mistral:7b'
          if (process.env.ANTHROPIC_API_KEY) {
            provider = 'anthropic'
            model = 'claude-haiku-4-5'
          } else if (process.env.OPENAI_API_KEY) {
            provider = 'openai'
            model = 'gpt-4o'
          } else if (process.env.GEMINI_API_KEY) {
            provider = 'gemini'
            model = 'gemini-2.0-flash-exp'
          }

          // Adapter factory pattern for multi-vendor support
          const adapterConfig: Record<string, () => any> = {
            anthropic: () =>
              anthropicText((model || 'claude-haiku-4-5') as any),
            openai: () => openaiText((model || 'gpt-4o') as any),
            gemini: () => geminiText((model || 'gemini-2.0-flash-exp') as any),
            ollama: () => ollamaText((model || 'mistral:7b') as any),
          }

          const adapter = adapterConfig[provider]()

          const stream = chat({
            adapter,
            tools: [
              getHospitalStats, // Server tool
              searchPatients, // Server tool
              showPatientCardToolDef, // No server execute - client renders it
            ],
            systemPrompts: [SYSTEM_PROMPT],
            agentLoopStrategy: maxIterations(5),
            messages,
            abortController,
          })

          return toServerSentEventsResponse(stream, { abortController })
        } catch (error: any) {
          // If request was aborted, return early (don't send error response)
          if (error.name === 'AbortError' || abortController.signal.aborted) {
            return new Response(null, { status: 499 }) // 499 = Client Closed Request
          }
          return new Response(
            JSON.stringify({ error: 'Failed to process chat request' }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }
      },
    },
  },
})
