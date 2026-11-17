/**
 * onnxruntime-node (the privacy name finder's model runtime, card #275)
 * downloads CUDA libraries from nuget.org during npm ci on linux/x64 unless
 * told not to. Hosted boxes have no GPU, and a failed download fails /update.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('.npmrc', () => {
  it('skips the onnxruntime-node GPU download on install', () => {
    const rc = readFileSync(resolve(__dirname, '..', '.npmrc'), 'utf-8')
    expect(rc).toMatch(/^onnxruntime-node-install=skip$/m)
  })
})
