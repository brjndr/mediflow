import {
  fetchServerSentEvents,
  useChat,
  createChatClientOptions,
} from '@tanstack/ai-react'
import type { InferChatMessages } from '@tanstack/ai-react'
import { clientTools } from '@tanstack/ai-client'

import { showPatientCardToolDef } from '#/lib/hospital-ai-tools'

const showPatientCardClient = showPatientCardToolDef.client(({ id }) => ({
  id,
}))

const chatOptions = createChatClientOptions({
  connection: fetchServerSentEvents('/demo/api/ai/chat'),
  tools: clientTools(showPatientCardClient),
})

export type ChatMessages = InferChatMessages<typeof chatOptions>

export const useHospitalAssistantChat = () => useChat(chatOptions)
