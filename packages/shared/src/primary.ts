// Primary value selection (Req 13). Shared so the UI drawer labels match the BFF's choice.
// First item with profileDefault === true (first in service order if several, Req 13.2),
// otherwise the first item; undefined for an empty collection (Req 13.3).
// T is any object type: items without profileDefault (e.g. GuestMembership) are accepted
// and fall through to the first item. A `{ profileDefault?: boolean }` constraint would
// reject such types under TypeScript's weak-type check.
export function pickPrimary<T extends object>(items: readonly T[]): T | undefined {
  return items.find((item) => 'profileDefault' in item && item.profileDefault === true) ?? items[0];
}
