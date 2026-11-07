import { lookup } from 'node:dns/promises'
import type { Adb } from './adb'
import { attributeSocket, parsePackageUids, parseProcNet, rememberSockets, type SeenSocket } from './procnet'

const POLL_MS = 250
const UID_REFRESH_MS = 5_000
const DNS_TTL_MS = 30_000

/** Polls the rooted phone so a request can be tagged with the app that opened the socket. */
export class Attributor {
  preferPkg?: string
  private sockets: SeenSocket[] = []
  private uids = new Map<number, string[]>()
  private uidAt = 0
  private dns = new Map<string, { ips: string[]; at: number }>()
  private stopped = false

  constructor(private readonly adb: Adb) {}

  start(): void {
    void this.loop()
  }

  stop(): void {
    this.stopped = true
  }

  async lookup(host: string, port: number): Promise<string | undefined> {
    const ips = await this.resolve(host)
    return attributeSocket({
      ips,
      port,
      at: Date.now(),
      sockets: this.sockets,
      uidToPkgs: this.uids,
      preferPkg: this.preferPkg,
    })
  }

  private async resolve(host: string): Promise<string[]> {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return [host]
    const hit = this.dns.get(host)
    if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.ips
    const found = await lookup(host, { all: true, verbatim: true }).catch(() => [])
    const ips = found.map((r) => r.address)
    this.dns.set(host, { ips, at: Date.now() })
    return ips
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now()
      try {
        const dump = await this.adb.shell('cat /proc/net/tcp /proc/net/tcp6')
        this.sockets = rememberSockets(this.sockets, parseProcNet(dump), Date.now(), 20_000)
        if (Date.now() - this.uidAt > UID_REFRESH_MS) {
          this.uids = parsePackageUids(await this.adb.shell('pm list packages -U'))
          this.uidAt = Date.now()
        }
      } catch {
        // The phone reboots while Play is installed. The next poll tries again.
      }
      const wait = Math.max(0, POLL_MS - (Date.now() - started))
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
