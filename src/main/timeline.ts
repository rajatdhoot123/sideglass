export interface PhoneInput {
  id: string
  at: number
  device: 'capture' | 'play'
  kind: 'tap' | 'swipe' | 'scroll' | 'key' | 'text'
  label: string
  /** Small JPEG data URL of the phone at this input, when the screen could provide one. */
  shot?: string
}

const WINDOW_MS = 2_000

/** Latest capture-phone input at or before [at], within two seconds. Play-phone gestures are not linked to captured traffic. */
export function inputForRequest(
  inputs: readonly PhoneInput[],
  at: number,
  windowMs = WINDOW_MS,
  device: PhoneInput['device'] = 'capture',
): string | undefined {
  let best: PhoneInput | undefined
  for (const input of inputs) {
    if (input.device !== device) continue
    if (input.at <= at && at - input.at <= windowMs && (!best || input.at > best.at)) best = input
  }
  return best?.id
}

/** Inputs recorded while the user drives the phone, so requests can be grouped under them. */
export class Timeline {
  readonly inputs: PhoneInput[] = []
  private nextId = 0

  add(input: Omit<PhoneInput, 'id' | 'at'> & { at?: number }): PhoneInput {
    const row: PhoneInput = { ...input, id: `${Date.now().toString(36)}-${this.nextId++}`, at: input.at ?? Date.now() }
    this.inputs.push(row)
    if (this.inputs.length > 2000) this.inputs.shift()
    return row
  }

  shot(id: string, dataUrl: string): PhoneInput | undefined {
    const row = this.inputs.find((i) => i.id === id)
    if (!row || !dataUrl.startsWith('data:image/')) return
    row.shot = dataUrl.slice(0, 200_000)
    return row
  }

  match(at: number): string | undefined {
    return inputForRequest(this.inputs, at)
  }

  clear(): void {
    this.inputs.length = 0
  }
}
