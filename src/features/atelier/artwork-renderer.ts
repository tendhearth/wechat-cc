/**
 * Provider-independent image-renderer seam for CC Atelier.
 *
 * Phase 0 only: this module is deliberately NOT wired into the daemon tick.
 * The first implementation uses OpenAI's single-prompt Image API because the
 * official API returns image bytes directly and does not require a chat model
 * to act as the brush. No automatic retry is performed: an ambiguous paid
 * timeout must not silently create/charge for a second image.
 */

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

export type ArtworkQuality = 'low' | 'medium' | 'high' | 'auto'
export type ArtworkSize = `${number}x${number}` | 'auto'

export interface ArtworkRenderRequest {
  /** Privacy-minimized visual prompt. Raw chat and private causal context never belong here. */
  prompt: string
  quality?: ArtworkQuality
  size?: ArtworkSize
}

export interface RenderedArtwork {
  bytes: Uint8Array
  mime: 'image/png'
  rendererId: string
  requestId?: string
  elapsedMs: number
}

export interface ArtworkRenderer {
  readonly id: string
  render(request: ArtworkRenderRequest): Promise<RenderedArtwork>
}

export type ArtworkRendererErrorCode =
  | 'renderer_auth_missing'
  | 'renderer_bad_request'
  | 'renderer_http_error'
  | 'renderer_bad_output'
  | 'renderer_output_too_large'
  | 'renderer_timeout'
  | 'renderer_exec_error'

export class ArtworkRendererError extends Error {
  constructor(readonly code: ArtworkRendererErrorCode, message: string, readonly status?: number) {
    super(message)
    this.name = 'ArtworkRendererError'
  }
}

export interface OpenAiImageRendererDeps {
  apiKey: string
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  now?: () => number
}

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: unknown }>
}

function isPng(bytes: Uint8Array): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value)
}

/** Shared by every renderer: reject non-PNG or oversized output. */
export function validatePngBytes(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.length === 0 || !isPng(bytes)) {
    throw new ArtworkRendererError('renderer_bad_output', 'image response was not a PNG')
  }
  if (bytes.length > maxBytes) {
    throw new ArtworkRendererError('renderer_output_too_large', `image exceeded ${maxBytes} bytes`)
  }
  return bytes
}

function decodePngBase64(value: string, maxBytes: number): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(Buffer.from(value, 'base64'))
  } catch {
    throw new ArtworkRendererError('renderer_bad_output', 'image response was not valid base64')
  }
  return validatePngBytes(bytes, maxBytes)
}

/**
 * Direct OpenAI Image API renderer. It returns bytes only; persistence belongs
 * to the future AtelierStore. Errors never include the API key, prompt, or
 * provider response body.
 */
export function makeOpenAiImageRenderer(deps: OpenAiImageRendererDeps): ArtworkRenderer {
  const apiKey = deps.apiKey.trim()
  if (!apiKey) throw new ArtworkRendererError('renderer_auth_missing', 'OPENAI_API_KEY is not configured')
  const model = deps.model?.trim() || DEFAULT_MODEL
  const baseUrl = (deps.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const now = deps.now ?? Date.now
  const id = `openai-image:${model}`

  return {
    id,
    async render(request) {
      const prompt = request.prompt.trim()
      if (!prompt) throw new ArtworkRendererError('renderer_bad_request', 'render prompt is empty')
      const startedAt = now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await doFetch(`${baseUrl}/images/generations`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt,
            n: 1,
            quality: request.quality ?? 'low',
            size: request.size ?? '1024x1024',
          }),
          signal: controller.signal,
        })
        const requestId = response.headers.get('x-request-id') ?? undefined
        if (!response.ok) {
          throw new ArtworkRendererError(
            'renderer_http_error',
            `image API returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}`,
            response.status,
          )
        }
        let body: OpenAiImageResponse
        try {
          body = await response.json() as OpenAiImageResponse
        } catch {
          throw new ArtworkRendererError('renderer_bad_output', 'image API returned invalid JSON')
        }
        const encoded = body.data?.[0]?.b64_json
        if (typeof encoded !== 'string') {
          throw new ArtworkRendererError('renderer_bad_output', 'image API response did not contain image bytes')
        }
        return {
          bytes: decodePngBase64(encoded, maxBytes),
          mime: 'image/png',
          rendererId: id,
          ...(requestId ? { requestId } : {}),
          elapsedMs: Math.max(0, now() - startedAt),
        }
      } catch (error) {
        if (error instanceof ArtworkRendererError) throw error
        if (controller.signal.aborted) {
          throw new ArtworkRendererError('renderer_timeout', `image API timed out after ${timeoutMs}ms`)
        }
        throw new ArtworkRendererError('renderer_http_error', `image API request failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

