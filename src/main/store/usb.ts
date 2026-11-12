import { Adb } from '../adb'
import { CAPTURE_PHONE } from '../emulator'

export interface UsbPhone {
  serial: string
  model: string
  /** Another emulator running on this computer (not one of Sideglass's own). */
  emulator: boolean
}

/** Sideglass's own virtual phones; they are chosen as "Virtual phone", not as a connected device. */
const OWN = new Set([CAPTURE_PHONE.port].map((port) => `emulator-${port}`))

/**
 * Devices Sideglass can use without root: real phones over USB (or Wi-Fi adb), then any other
 * emulator already running on this computer.
 */
export async function usbPhones(adbPath: string): Promise<UsbPhone[]> {
  const devices = (await Adb.devices(adbPath)).filter((d) => d.state === 'device' && !OWN.has(d.serial))
  const list = await Promise.all(
    devices.map(async (d) => {
      const adb = new Adb(adbPath, d.serial)
      const emulator = d.serial.startsWith('emulator-')
      // An emulator's model is a generic "sdk_gphone…"; its AVD name tells them apart.
      const avd = emulator ? (await adb.exec(['emu', 'avd', 'name']).catch(() => '')).split(/\r?\n/)[0].trim() : ''
      const model = avd || (await adb.shell('getprop ro.product.model').catch(() => d.serial)).trim()
      return { serial: d.serial, model, emulator }
    }),
  )
  return list.sort((a, b) => Number(a.emulator) - Number(b.emulator))
}

/** Apps the user installed on that phone (not system apps). */
export async function userApps(adb: Adb): Promise<string[]> {
  const out = await adb.shell('pm list packages -3')
  return out
    .split('\n')
    .map((l) => l.replace('package:', '').trim())
    .filter(Boolean)
    .sort()
}
