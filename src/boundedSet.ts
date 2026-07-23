export function addBoundedSetValue<T>(set: Set<T>, value: T, maxSize: number): void {
  if (set.has(value)) set.delete(value);
  set.add(value);
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

export const MAX_RECENTLY_READ_EMAILS = 2_000;
export const MAX_REMOTE_IMAGE_EMAILS = 500;
