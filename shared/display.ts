import type { DisplayState } from './satellite.js';

export function displayMessage(display: DisplayState | undefined): string {
  if (!display) return 'Update this frame to use sleep hours.';
  if (!display.connected) return 'The Pi’s display service is not connected. Run the updated Pi setup once to enable sleep hours.';
  if (display.error) return display.error;
  const zone = display.timeZone?.split('/').at(-1)?.replaceAll('_', ' ');
  return `Repeats daily in ${zone ? `${zone} time` : 'the frame’s local time'}. The Pi stays online while the screen sleeps.`;
}
