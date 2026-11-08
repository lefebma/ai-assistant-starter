/** A minimal zip writer for tests (card #280), so fixtures can hold names and sizes no honest tool would write. */
import { crc32, deflateRawSync } from 'node:zlib'

export interface FixtureEntry {
  name: string
  data: Buffer | string
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number
  /** General purpose flags, e.g. 0x1 for encrypted. */
  flags?: number
}

export function buildZip(entries: FixtureEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const method = e.method ?? 8
    const body = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name, 'utf8')
    const size = e.declaredSize ?? raw.length
    const crc = crc32(raw)
    const flags = (e.flags ?? 0) | 0x800

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}
