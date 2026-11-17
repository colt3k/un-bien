/**
 * Browser stand-in for the `ws` client that the un-bien `RelayClient` drives.
 * Aliased over the bare `ws` specifier (see vite.config.ts).
 *
 * `RelayClient` uses only this surface of `ws`: the EventEmitter-style
 * `.on`/`.once`, `send(data, cb?)`, `close()`, `terminate()`, and
 * `readyState`/`WebSocket.OPEN`. The native WebSocket gives us all of it.
 *
 * ONE real difference, and it is worth stating rather than hiding:
 * browsers do not expose WS ping/pong frames to JavaScript. The relay pings
 * every ~25s (and the browser answers automatically), but `RelayClient`'s
 * liveness watchdog only ever sees DATA frames — so an idle session is
 * force-closed after ~70s of silence and the app reconnects. Faking inbound
 * activity here would blind the watchdog to genuinely dead sockets, which is
 * the failure that watchdog exists to catch. Reconnecting costs a re-auth plus
 * an incremental `get_entries{since}` re-read; that is the cheaper mistake.
 */
type Handler = (...args: unknown[]) => void

export default class WebSocketShim {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  private readonly socket: WebSocket
  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(url: string, _options?: unknown) {
    this.socket = new WebSocket(url)
    this.socket.binaryType = "arraybuffer"

    this.socket.addEventListener("open", () => this.fire("open"))
    this.socket.addEventListener("message", (event: MessageEvent) =>
      this.fire("message", decode(event.data)),
    )
    this.socket.addEventListener("error", () =>
      // ws hands its error listeners an Error; the native event carries none.
      this.fire("error", new Error(`websocket error: ${url}`)),
    )
    this.socket.addEventListener("close", (event: CloseEvent) =>
      this.fire("close", event.code, event.reason),
    )
  }

  get readyState(): number {
    return this.socket.readyState
  }

  on(event: string, handler: Handler): void {
    const set = this.handlers.get(event) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(event, set)
  }

  once(event: string, handler: Handler): void {
    const wrapped: Handler = (...args: unknown[]) => {
      this.handlers.get(event)?.delete(wrapped)
      handler(...args)
    }
    this.on(event, wrapped)
  }

  send(data: string, callback?: (err?: Error) => void): void {
    try {
      this.socket.send(data)
      callback?.()
    } catch (err) {
      callback?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  close(): void {
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close()
  }

  /** ws's abrupt close. The browser has no abrupt variant; a plain close is
   *  the same outcome for `RelayClient` (it wants the `close` event). */
  terminate(): void {
    this.close()
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }
}

function decode(data: string | ArrayBuffer | ArrayBufferView): string {
  if (typeof data === "string") return data
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new TextDecoder().decode(bytes)
}
