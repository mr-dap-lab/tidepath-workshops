import type { Deck } from './decks.ts'
import { WorkflowError } from './workflow-types.ts'

export const modelEnabled = () => Boolean(process.env.MODEL_ENDPOINT)

interface ModelAdapter {
  propose(operation: 'intake' | 'deck', data: object): Promise<unknown>
}

function modelAdapter(): ModelAdapter | undefined {
  if (!process.env.MODEL_ENDPOINT) return undefined
  const endpoint = new URL(process.env.MODEL_ENDPOINT)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && endpoint.hostname === 'localhost')) {
    throw new WorkflowError('The model gateway must use HTTPS or localhost.')
  }
  return {
    async propose(operation, data) {
      const token = process.env.MODEL_API_KEY
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ operation, data }),
      })
      if (!response.ok) throw new WorkflowError('The model did not return a proposal. Continue with staff review.')
      return await response.json()
    },
  }
}

export async function modelIntake(body: string, keys: string[]) {
  if (!modelEnabled()) return undefined
  try {
    const result = await modelAdapter()!.propose('intake', { body, keys })
    if (!result || typeof result !== 'object' || !('fields' in result) || !result.fields ||
        typeof result.fields !== 'object' || !('uncertain' in result) || typeof result.uncertain !== 'boolean') {
      return { fields: {}, uncertain: true }
    }
    const fields: Record<string, string> = {}
    let uncertain = result.uncertain
    for (const [key, value] of Object.entries(result.fields)) {
      if (!keys.includes(key) || typeof value !== 'string' || !value.trim() || value.length > 300 ||
          !body.toLowerCase().includes(value.trim().toLowerCase())) {
        uncertain = true
      } else {
        fields[key] = value.trim()
      }
    }
    return { fields, uncertain }
  } catch {
    return { fields: {}, uncertain: true }
  }
}

export async function modelDeck(template: Deck, topic: string, grade: string, notes: string, feedback: string[]): Promise<Deck> {
  const model = modelAdapter()
  if (!model) throw new WorkflowError('The model gateway is not configured.')
  const result = await model.propose('deck', {
    topic, grade, notes, feedback, template: { ...template, slides: template.slides.map((slide, index) =>
      index === 0 ? { ...slide, text: grade } : slide) },
  })
  if (!result || typeof result !== 'object' || !('uncertain' in result) || result.uncertain !== false ||
      !('language' in result) || result.language !== template.language || !('slides' in result) ||
      !Array.isArray(result.slides) || result.slides.length !== template.slides.length ||
      result.slides.some(slide => !slide || typeof slide.title !== 'string' || !slide.title.trim() || slide.title.length > 150 ||
        typeof slide.text !== 'string' || !slide.text.trim() || slide.text.length > 2000)) {
    throw new WorkflowError('The model did not return a valid draft in the selected workshop language. Revise the template manually.')
  }
  return { language: template.language, template: template.template, slides: result.slides.map(({ title, text }, index) => ({
    title, text: index === 0 ? template.slides[0].text : text,
  })) }
}
