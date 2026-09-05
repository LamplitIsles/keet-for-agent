declare module 'tiny-buffer-rpc' {
  interface Encoding {
    preencode(state: unknown, value: unknown): void
    encode(state: unknown, value: unknown): void
    decode(state: unknown): unknown
  }

  interface RpcMethod {
    request(data: unknown): Promise<unknown>
    createRequestStream(): import('node:stream').Duplex
  }

  export default class TinyBufferRPC {
    constructor(send: (message: Buffer) => void)
    register(
      id: number,
      options: {
        request: Encoding
        response: Encoding
        onrequest?: (data: unknown) => unknown | Promise<unknown>
      },
    ): RpcMethod
    recv(message: Buffer): void
    destroy(): void
  }
}

declare module 'tiny-buffer-rpc/any.js' {
  const any: {
    preencode(state: unknown, value: unknown): void
    encode(state: unknown, value: unknown): void
    decode(state: unknown): unknown
  }
  export default any
}
