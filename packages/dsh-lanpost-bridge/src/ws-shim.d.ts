/**
 * `ws` 的最小环境声明。
 *
 * 仓库没有安装 @types/ws，而本包只需要 socket 的 4 个成员；这里按实际用法声明，
 * 避免为三个方法引入完整类型包。若将来安装 @types/ws，请删除本文件。
 */
declare module 'ws' {
  class WebSocket {
    constructor(url: string, options?: { handshakeTimeout?: number })
    send(data: string): void
    close(code?: number, reason?: string): void
    on(event: string, listener: (...args: any[]) => void): this
  }

  export default WebSocket
}
