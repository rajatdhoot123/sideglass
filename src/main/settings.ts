import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Settings } from '../shared'

/** The user's choices, kept as JSON in the app's data folder. Missing `phone` means "ask". */
export function loadSettings(file: string): Settings {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Settings
    return {
      phone: parsed.phone === 'virtual' || parsed.phone === 'usb' ? parsed.phone : undefined,
      usbSerial: typeof parsed.usbSerial === 'string' && parsed.usbSerial ? parsed.usbSerial : undefined,
    }
  } catch {
    return {}
  }
}

export function saveSettings(file: string, settings: Settings): Settings {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2))
  return settings
}
