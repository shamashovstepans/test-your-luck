/**
 * Haptics support for mobile devices using the Web Vibration API.
 * Works on Chrome Android, Samsung Internet, and other supported browsers.
 * Gracefully no-ops on unsupported devices (e.g. iOS Safari, desktop).
 */

const SUPPORTS_VIBRATION =
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

/** Light tap - for throw initiation */
const PATTERN_THROW: number | number[] = 30

/** Medium feedback - when dice settle */
const PATTERN_SETTLE: number | number[] = [20, 30, 20]

/** Strong feedback - for rare combos (six of a kind, large straight, etc.) */
const PATTERN_COMBO: number | number[] = [50, 30, 50, 30, 80]

/** Very light - for UI interactions (button tap) */
const PATTERN_LIGHT: number | number[] = 10

function vibrate(pattern: number | number[]): boolean {
  if (!SUPPORTS_VIBRATION) return false
  try {
    return navigator.vibrate(pattern)
  } catch {
    return false
  }
}

/**
 * Trigger haptic feedback when the user initiates a dice throw.
 * Call from a user gesture (click/tap) for best compatibility.
 */
export function hapticsThrow(): void {
  vibrate(PATTERN_THROW)
}

/**
 * Trigger haptic feedback when dice have settled and results are shown.
 */
export function hapticsSettle(): void {
  vibrate(PATTERN_SETTLE)
}

/**
 * Trigger stronger haptic feedback for rare/special combos.
 * Use when the player gets six of a kind, large straight, etc.
 */
export function hapticsCombo(): void {
  vibrate(PATTERN_COMBO)
}

/**
 * Light haptic for general UI interactions (button taps, etc.)
 */
export function hapticsLight(): void {
  vibrate(PATTERN_LIGHT)
}

/**
 * Check if haptics are supported on this device.
 */
export function hapticsSupported(): boolean {
  return SUPPORTS_VIBRATION
}
