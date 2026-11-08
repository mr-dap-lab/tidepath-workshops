import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { digest, type RecordState, WorkflowError } from './workflow-types.ts'

type Slide = { title: string; text: string }
export type Deck = { language: string; template?: string; slides: Slide[] }
const templates: Record<string, [string, string, string, string, string, string]> = {
  English: ['Today’s goal', 'Practice a strategy you can use this week.', 'Try it together', 'In pairs, listen, reflect what you heard, and take turns.', 'Take it with you', 'Write down one action you will try and one person who can help.'],
  Spanish: ['Objetivo de hoy', 'Practiquemos una estrategia que puedan usar esta semana.', 'Practiquemos en equipo', 'En parejas, escuchen, repitan lo que entendieron y tomen turnos.', 'Para llevar', 'Escriban una acción que pondrán en práctica y una persona que les pueda ayudar.'],
  'Haitian Creole': ['Objektif jodi a', 'Pratike yon estrateji nou ka itilize semèn sa a.', 'Ann pratike ansanm', 'An pè, koute, repete sa nou konprann, epi pran tou pa nou.', 'Sa n ap pote ale', 'Ekri yon aksyon n ap eseye ak yon moun ki ka ede nou.'],
}

const coping: Record<string, [string, string, string, string]> = {
  English: ['Coping strategies', 'Notice what stress feels like and practice a short reset.', 'Take a slow breath, notice five things around you, and pick one next step.', 'Choose a reset strategy to try before the next class.'],
  Spanish: ['Estrategias para manejar el estrés', 'Reconozcan cómo se siente el estrés y practiquen una pausa breve.', 'Respiren despacio, observen cinco cosas a su alrededor y elijan un siguiente paso.', 'Elijan una estrategia para practicar antes de la próxima clase.'],
  'Haitian Creole': ['Estrateji pou jere estrès', 'Rekonèt jan estrès santi l epi pratike yon ti poz.', 'Pran yon souf dousman, remake senk bagay bò kote nou, epi chwazi yon pwochen etap.', 'Chwazi yon estrateji pou eseye anvan pwochen klas la.'],
}

export function draftDeck(record: RecordState, title: string, activity: string, prior?: Deck, selected = ''): Deck {
  const language = record.details.workshop_language || 'English'
  const template = selected || prior?.template || 'communication'
  if (!['communication', 'coping'].includes(template)) throw new WorkflowError('Choose a workshop template.', 400)
  if (prior?.language === language && (prior.template ?? 'communication') === template) {
    const slides = prior.slides.map(slide => ({ ...slide }))
    if (title) slides[0].title = title
    if (activity) slides[2].text = activity
    return { language, template, slides }
  }
  const [goal, goalText, exercise, exerciseText, takeaway, takeawayText] = templates[language] ?? templates.English
  const defaultTitle = language === 'Spanish' ? 'Comunicación y bienestar' :
    language === 'Haitian Creole' ? 'Kominikasyon ak byennèt' : record.details.topic || 'Communication and well-being'
  const [baseTitle, baseGoal, baseExercise, baseTakeaway] = template === 'coping' ?
    (coping[language] ?? coping.English) : [defaultTitle, goalText, exerciseText, takeawayText]
  return { language, template, slides: [
    { title: title || baseTitle, text: [record.details.school, record.details.grade].filter(Boolean).join(' · ') },
    { title: goal, text: baseGoal },
    { title: exercise, text: activity || baseExercise },
    { title: takeaway, text: baseTakeaway },
  ] }
}

const html = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function render(deck: Deck) {
  const lang = deck.language === 'Spanish' ? 'es' : deck.language === 'Haitian Creole' ? 'ht' : 'en'
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(deck.slides[0].title)}</title><style>
  body{margin:0;background:#f4f6f3;color:#152b29;font:1.3rem/1.45 system-ui}section{background:white;border:1px solid #dce4dd;border-top:8px solid #17645e;border-radius:12px;margin:2rem auto;padding:clamp(1.5rem,6vw,5rem);max-width:820px;min-height:250px} h1,h2{font:500 clamp(2rem,5vw,4rem)/1.1 Georgia,serif;margin:0}p{white-space:pre-wrap}@media print{section{break-after:page;min-height:50vh}}
  </style></head><body>${deck.slides.map((slide, i) => `<section><${i ? 'h2' : 'h1'}>${html(slide.title)}</${i ? 'h2' : 'h1'}><p>${html(slide.text)}</p></section>`).join('')}</body></html>`
}

function root() {
  return resolve(process.env.DECK_STORAGE_DIR ?? '.private-decks')
}

export async function storeDeck(tenantId: string, deck: Deck) {
  const content = render(deck)
  const checksum = digest(content)
  const directory = join(root(), tenantId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staged = join(directory, randomUUID() + '.tmp')
  try {
    await writeFile(staged, content, { flag: 'wx', mode: 0o600 })
    await link(staged, join(directory, checksum + '.html'))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  } finally {
    await rm(staged, { force: true })
  }
  return { key: checksum + '.html', checksum }
}

export async function readDeck(tenantId: string, key: string, checksum: string) {
  if (key !== checksum + '.html' || !/^[a-f0-9]{64}$/.test(checksum)) throw new WorkflowError('Deck file is unavailable.', 404)
  const file = await readFile(join(root(), tenantId, key), 'utf8')
  if (digest(file) !== checksum) throw new WorkflowError('Deck file failed its integrity check.', 409)
  return file
}
