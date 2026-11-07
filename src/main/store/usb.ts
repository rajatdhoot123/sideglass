import { Adb } from '../adb'

export interface UsbPhone {
  serial: string
  model: string
}

/** Real phones over USB (or Wi-Fi adb): every adb device that is not an emulator. */
export async function usbPhones(adbPath: string): Promise<UsbPhone[]> {
  const devices = (await Adb.devices(adbPath)).filter((d) => d.state === 'device' && !d.serial.startsWith('emulator-'))
  return Promise.all(
    devices.map(async (d) => ({
      serial: d.serial,
      model: (await new Adb(adbPath, d.serial).shell('getprop ro.product.model').catch(() => d.serial)).trim(),
    })),
  )
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
