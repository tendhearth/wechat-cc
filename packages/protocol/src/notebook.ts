import z from 'zod'

export const NOTEBOOK_FONTS = { kai: '楷体', hand: '手写体', fangsong: '仿宋', songItalic: '宋体斜' } as const
export const NOTEBOOK_INKS = { blueBlack: '蓝黑', darkGreen: '墨绿', ochre: '赭石', greyPurple: '灰紫' } as const

export const NotebookBody = z.string().refine(s => !!s.trim() && !s.includes('\0') && Array.from(s).length <= 4000)
export const NotebookPaper = z.enum(['ruled', 'plain'])
export const NotebookPen = z.object({
  font: z.enum(['kai', 'hand', 'fangsong', 'songItalic']),
  ink: z.enum(['blueBlack', 'darkGreen', 'ochre', 'greyPurple']),
  reason: z.string(),
}).strict()
export const NotebookDay = z.string().refine(day => /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day)
export const NotebookEntry = z.object({
  id: z.string().uuid(),
  author: z.enum(['owner', 'cc']),
  body: NotebookBody,
  createdAt: z.number().int(),
  day: NotebookDay,
  refId: z.string().uuid().nullable(),
  refDay: NotebookDay.optional(),
  struckAt: z.number().int().nullable(),
  origin: z.enum(['desktop', 'app', 'chat']),
  clientId: z.string().nullable(),
})
export const NotebookPageQuery = z.object({
  day: NotebookDay.optional(),
  after: NotebookEntry.shape.id.optional(),
  fonts: z.string().optional().describe('Comma-separated font keys available to the caller. Values over 200 characters are ignored.'),
}).refine(query => query.after === undefined || query.day !== undefined)
export type NotebookPageQueryT = z.input<typeof NotebookPageQuery>
export const NotebookPageResponse = z.object({
  day: NotebookDay,
  today: NotebookDay,
  days: z.array(NotebookDay),
  entries: z.array(NotebookEntry),
  nextAfter: z.string().uuid().optional(),
  pen: NotebookPen,
  penPending: z.boolean(),
  paper: NotebookPaper,
})
export const NotebookWriteRequest = z.object({ body: NotebookBody, clientId: z.string().min(1).max(128) }).strict()
export const NotebookWriteResponse = z.object({ entry: NotebookEntry })
export const NotebookStrikeRequest = z.object({ id: z.string().uuid(), struck: z.boolean() }).strict()
export const NotebookStrikeResponse = z.object({ ok: z.literal(true) })
export const NotebookPaperRequest = z.object({ paper: NotebookPaper }).strict()
export const NotebookPaperResponse = NotebookPaperRequest
export const NOTEBOOK_JOT_PREFIX = '你说：'
export const NotebookJotRequest = z.object({
  text: NotebookBody.refine(s => !/[\r\n\u2028\u2029]/u.test(s) && Array.from(s).length <= 4000 - NOTEBOOK_JOT_PREFIX.length),
}).strict()
export const NotebookChatReadRequest = z.object({
  days: z.number().int().min(1).max(60).default(7),
  after: NotebookEntry.shape.id.optional(),
  query: z.string().max(4000).optional(),
}).strict()
export const NotebookJotResponse = z.object({ ok: z.literal(true), id: NotebookEntry.shape.id })
export const NotebookChatReadResponse = z.object({ entries: z.array(NotebookEntry), nextAfter: NotebookEntry.shape.id.optional() })
export type NotebookChatReadResponseT = z.infer<typeof NotebookChatReadResponse>
export type NotebookEntryT = z.infer<typeof NotebookEntry>
export type NotebookPaperT = z.infer<typeof NotebookPaper>
export type NotebookPenT = z.infer<typeof NotebookPen>
export type NotebookPageResponseT = z.infer<typeof NotebookPageResponse>
