export type MinifluxUserTimeZone = { timezone?: string };

export function loadOptionalMinifluxTimeZone(
  loadUser: () => Promise<MinifluxUserTimeZone>,
): Promise<string | undefined>;
