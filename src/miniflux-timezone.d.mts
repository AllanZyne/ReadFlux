export type MinifluxUserTimeZone = { timezone?: string };

export function loadOptionalMinifluxTimeZone(
  loadUser: () => Promise<MinifluxUserTimeZone>,
): Promise<string | undefined>;

export function startOptionalMinifluxTimeZoneLoad(
  loadUser: () => Promise<MinifluxUserTimeZone>,
  onLoaded: (timeZone: string | undefined) => void,
): void;
