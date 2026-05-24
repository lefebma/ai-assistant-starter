// Type stub for @slack/bolt (optional dependency, loaded dynamically).
// Install with: npm install @slack/bolt
declare module '@slack/bolt' {
  export class App {
    constructor(options: {
      token: string
      appToken: string
      socketMode: boolean
    })
    message(handler: (args: any) => Promise<void>): void
    action(pattern: RegExp, handler: (args: any) => Promise<void>): void
    client: {
      chat: {
        postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>
        update(args: Record<string, unknown>): Promise<void>
      }
      conversations: {
        history(args: Record<string, unknown>): Promise<{ messages?: Array<{ text?: string }> }>
      }
      files: {
        uploadV2(args: Record<string, unknown>): Promise<void>
      }
    }
    start(): Promise<void>
    stop(): Promise<void>
  }
}
