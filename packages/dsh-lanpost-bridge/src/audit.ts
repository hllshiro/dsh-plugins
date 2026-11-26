// lanpost-bridge 审计日志：把关键行为逐行追加到 `$DSH_HOME/dsh-lanpost-bridge.audit.log`。
// 一行一条：`<ISO 时间>\t<kind>\t<JSON detail>`；JSON 由 JSON.stringify 压成单行（换行转义），
// 只追加不覆盖，文件不存在时按 0600 创建。
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

/** 审计日志路径：`$DSH_HOME/dsh-lanpost-bridge.audit.log`。 */
export function auditPath(home: string): string {
  return join(home, 'dsh-lanpost-bridge.audit.log')
}

/** 一行审计内容；键序取 detail 的插入顺序，由 JSON.stringify 默认行为决定。 */
export function auditLine(kind: string, detail: Record<string, unknown>, iso: string): string {
  return `${iso}\t${kind}\t${JSON.stringify(detail)}`
}

/** 追加一条审计记录，ISO 时间取当前时刻；文件不存在时按 0600 创建。 */
export function appendAudit(home: string, kind: string, detail: Record<string, unknown>): void {
  appendFileSync(auditPath(home), `${auditLine(kind, detail, new Date().toISOString())}\n`, { mode: 0o600 })
}
