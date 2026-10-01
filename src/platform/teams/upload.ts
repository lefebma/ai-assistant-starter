/**
 * The one-shot PUT that puts a file in the user's OneDrive after they accept
 * a consent card.
 *
 * Separate from BotConnector on purpose. Every connector call carries the
 * bot's bearer token, and this call must not: the upload URL Teams hands back
 * is already pre-authorized for exactly this write, so attaching the token
 * would leak a credential to a host outside the Bot Framework for no gain.
 */
import { logger } from '../../logger.js'
import type { FetchLike } from './auth.js'
import { isOneDriveUploadHost, uploadHeaders } from './files.js'

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export async function putFileBytes(url: string, bytes: Buffer, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<void> {
  if (!isOneDriveUploadHost(url)) {
    // Not a thrown ConnectorError: this is a refusal, not a failure, and the
    // adapter turns it into a plain sentence for the owner.
    throw new UploadError(0, 'refusing to upload: the address Teams returned is not a OneDrive host')
  }
  const resp = await fetchImpl(url, {
    method: 'PUT',
    headers: uploadHeaders(bytes.length),
    body: bytes as unknown as BodyInit,
  })
  if (resp.status !== 200 && resp.status !== 201) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300)
    logger.warn({ status: resp.status, detail }, 'Teams: file upload failed')
    throw new UploadError(resp.status, `OneDrive upload failed: ${resp.status}`)
  }
}
