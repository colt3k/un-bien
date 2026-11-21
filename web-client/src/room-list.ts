import type { RoomInfo } from "./session-client.js"

/**
 * Rooms are live registrations, not stored rows: a peer's socket closing drops
 * its room, and a reconnect mints a NEW room id (observed in the relay log:
 * `disconnected room=rwQ-Lgirk8-y` then `authenticated room=lij44pP9h-Tw` 330ms
 * apart). The name/cwd/capabilities arrive in a separate `room_meta`, so a
 * refresh can legitimately see a room with no metadata at all.
 *
 * Rendering that raw makes cards vanish, reappear, and flip between a bare id
 * and a name — which is what this module exists to stop.
 */

/** Consecutive refreshes that may omit a room before its card is dropped. */
export const MISSING_GRACE = 2

export interface TrackedRoom extends RoomInfo {
  /** Refreshes in a row that have not mentioned this room. */
  misses: number
}

/**
 * Merge one `rooms_check` reply into what we already know, keyed by room id.
 *
 * Two deliberate choices:
 * - A reply that omits a field does NOT clear it. Registration and metadata
 *   are separate messages, so "absent" means "not stated this time", never
 *   "is now empty". Clearing it is exactly the id↔name flicker.
 * - A room that is absent is kept for MISSING_GRACE refreshes, so a
 *   reconnect's momentary gap doesn't make the card blink out.
 */
export function mergeRooms(
  prev: ReadonlyMap<string, TrackedRoom>,
  incoming: readonly RoomInfo[],
): Map<string, TrackedRoom> {
  const next = new Map<string, TrackedRoom>()
  for (const [id, room] of prev)
    next.set(id, { ...room, misses: room.misses + 1 })

  for (const room of incoming) {
    const known = prev.get(room.room_id)
    const merged: TrackedRoom = { room_id: room.room_id, misses: 0 }
    // Start from what we knew, then overlay only what this reply states.
    if (known)
      Object.assign(merged, known, { room_id: room.room_id, misses: 0 })
    for (const [key, value] of Object.entries(room)) {
      if (isStated(value))
        Object.assign(merged, { [key]: value } as Partial<TrackedRoom>)
    }
    next.set(room.room_id, merged)
  }

  for (const [id, room] of next)
    if (room.misses > MISSING_GRACE) next.delete(id)
  return next
}

/** Did the machine actually state this field, as opposed to leaving it out? */
function isStated(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** A control room drives the machine (remote launch/pair); it has no transcript. */
export function isControlRoom(room: RoomInfo): boolean {
  return (room.caps ?? []).some((cap) => cap.startsWith("remote_launch"))
}

/** Only a room carrying a pi session id has a transcript to show. */
export function isViewableSession(room: RoomInfo): boolean {
  return !!room.sessionId && !isControlRoom(room)
}

/**
 * Sort into a stable order. The relay's room list comes back in arbitrary
 * order, so rendering it raw makes the card in a given slot be a different
 * room on each refresh — a name that appears to change by itself.
 */
export function sortRooms(rooms: readonly TrackedRoom[]): TrackedRoom[] {
  return [...rooms].sort((a, b) => {
    const byGroup = rank(a) - rank(b)
    if (byGroup !== 0) return byGroup
    const byName = roomTitle(a).localeCompare(roomTitle(b))
    return byName !== 0 ? byName : a.room_id.localeCompare(b.room_id)
  })
}

/** Sessions first, then rooms we know nothing about, then control rooms. */
function rank(room: TrackedRoom): number {
  if (isViewableSession(room)) return 0
  if (isControlRoom(room)) return 2
  return 1
}

/** Control rooms are hidden unless asked for: attaching to one is a dead end. */
export function visibleRooms(
  rooms: readonly TrackedRoom[],
  showControlRooms: boolean,
): TrackedRoom[] {
  return sortRooms(
    rooms.filter((room) => showControlRooms || !isControlRoom(room)),
  )
}

export function roomTitle(room: TrackedRoom): string {
  return room.name || room.room_id
}

/** One-line badge telling the user what kind of room this is. */
export function roomTag(room: TrackedRoom): string {
  if (isControlRoom(room)) return "control room"
  if (room.sessionId) return "session"
  return "awaiting details"
}

/** Facts line: cwd, capability count, short session id, short room id. */
export function roomFacts(room: TrackedRoom): string[] {
  const facts: string[] = []
  if (room.cwd) facts.push(room.cwd)
  if (room.caps?.length) facts.push(`${room.caps.length} capabilities`)
  if (room.sessionId) facts.push(`session ${room.sessionId.slice(0, 8)}`)
  // The id is always shown: it is the only field that identifies a room across
  // re-announcements, and the only thing to quote when a room looks wrong.
  facts.push(`room ${room.room_id.slice(0, 8)}`)
  return facts
}

/** Array-shaped convenience over {@link mergeRooms}, matching how the app
 *  stores rooms per peer. */
export function mergeRoomLists(
  prev: readonly TrackedRoom[],
  incoming: readonly RoomInfo[],
): TrackedRoom[] {
  const before = new Map(prev.map((room) => [room.room_id, room]))
  return [...mergeRooms(before, incoming).values()]
}
