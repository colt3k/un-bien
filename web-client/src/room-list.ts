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

/**
 * A launcher's control room: routable, but with no transcript.
 *
 * `is_daemon` is the marker the extension stamps for exactly this
 * (extension/src/launcher/launcher.ts `DAEMON_CAPS`). Testing for
 * `remote_launch` instead — which this did — mislabels a LIVE session: a pi
 * whose cwd has `allow_remote_launch` advertises that cap too
 * (sessionCapabilities), so its card lost its attach button and became a
 * "control room" with no transcript. The fallback covers a daemon predating
 * the cap: it can never carry a pi session id, which every real session does.
 */
export function isControlRoom(room: RoomInfo): boolean {
  const caps = room.caps ?? []
  if (caps.includes("is_daemon")) return true
  return !room.sessionId && caps.some((cap) => cap === "remote_launch")
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

/** Control rooms stay out of the room list unless asked for: they have no
 *  transcript to attach to. They are still driveable — see `controlRoomOf`,
 *  which is how the machine card reaches them for remote launch. */
export function visibleRooms(
  rooms: readonly TrackedRoom[],
  showControlRooms: boolean,
): TrackedRoom[] {
  return sortRooms(
    rooms.filter((room) => showControlRooms || !isControlRoom(room)),
  )
}

/**
 * The machine's launcher room, if it has one — the room that answers
 * `session_launch`. Looked up per machine rather than rendered per room, so
 * launching does not depend on the "control rooms" checkbox being ticked.
 *
 * A live session answers `session_launch` too (extension/src/launch_request.ts
 * is shared), but its room is a chat: driving it must stay a chat. So this
 * takes the daemon specifically, and only falls back to a session-less
 * `remote_launch` room when no daemon announced itself.
 */
export function controlRoomOf(
  rooms: readonly TrackedRoom[],
): TrackedRoom | undefined {
  const sorted = sortRooms(rooms)
  return (
    sorted.find((room) => room.caps?.includes("is_daemon")) ??
    sorted.find(isControlRoom)
  )
}

/**
 * The room a launch produced: the one echoing our request id back in its
 * `room_meta`. Exact match only — "some new room appeared" is not evidence,
 * since another device can start a session at the same moment and this client
 * holds no before/after snapshot to diff. A launch whose room never echoes
 * (an older extension) simply shows up in the list to pick by hand.
 */
export function launchedRoom(
  rooms: readonly TrackedRoom[],
  requestId: string,
): TrackedRoom | undefined {
  if (!requestId) return undefined
  return rooms.find((room) => room.launchReq === requestId)
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

/**
 * Apply a frame that speaks about ONE room — `room_announced`,
 * `room_meta_updated` — without reading it as a listing.
 *
 * {@link mergeRooms} ages out every room the reply does not mention, which is
 * right for a `rooms_check` answer and wrong for a metadata push: the machine
 * pushes `room_meta_updated` for a live session whenever `working` flips — on a
 * busy session, one every couple of seconds (counted in a captured relay
 * frame log: 10 pushes in 24 frames). Pushed through the listing merge, each of
 * those was a miss for every OTHER room the machine owns, so a launcher's
 * control room — which is never re-stated — was erased three frames after load,
 * and the machine's launch button with it. Refresh re-listed it, so the button
 * looked like it needed a refresh to appear.
 *
 * (The first diagnosis here was that `rooms_check` does not list control rooms.
 * A capture of the relay's frames shows it listing them — the client was
 * deleting them. Fixing the merge, not the grace period, is the fix.)
 */
export function applyRoomUpdate(
  prev: readonly TrackedRoom[],
  room: RoomInfo,
): TrackedRoom[] {
  const known = prev.find((candidate) => candidate.room_id === room.room_id)
  const merged: TrackedRoom = {
    ...(known ?? { room_id: room.room_id, misses: 0 }),
  }
  for (const [key, value] of Object.entries(room)) {
    if (isStated(value))
      Object.assign(merged, { [key]: value } as Partial<TrackedRoom>)
  }
  merged.room_id = room.room_id
  // A frame naming a room is a statement that it is there: its misses reset.
  // Every other room is left exactly as it was — this reply says nothing about
  // them, and silence is not evidence of absence.
  merged.misses = 0
  return [...prev.filter((other) => other.room_id !== room.room_id), merged]
}
