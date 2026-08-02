export async function loadOptionalMinifluxTimeZone(loadUser) {
  try {
    const user = await loadUser();
    return typeof user?.timezone === "string" ? user.timezone : undefined;
  } catch {
    return undefined;
  }
}

export function startOptionalMinifluxTimeZoneLoad(loadUser, onLoaded) {
  void loadOptionalMinifluxTimeZone(loadUser).then(onLoaded);
}
