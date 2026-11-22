/**
 * The machine's answer to "which folders may I launch into?".
 *
 * A browser cannot know it. `launch.dirs` is a PREFIX test against the
 * extension machine's filesystem (`launchDirAllowed` in
 * `extension/src/launch.ts`), and the user writes it in their own shorthand —
 * `~/dev/myai` means nothing to the device. Hand-typing an absolute path under
 * those conditions means guessing a path you cannot see on a screen that is not
 * the machine's. So the daemon answers the question it is the only one able to
 * answer: each configured root, expanded to an absolute path, with its
 * immediate child directories.
 *
 * One level deep, and the machine's choice rather than ours: a device that
 * could walk the tree through a paired socket could read a home directory. A
 * project is one level down, which is exactly enough.
 */

export interface LaunchDirChild {
  /** Absolute ON THE MACHINE — used verbatim as `session_launch.cwd`. */
  path: string
  name: string
}

export interface LaunchDirRoot extends LaunchDirChild {
  exists: boolean
  truncated: boolean
  /** Why a root has no children: configured but gone (unmounted volume,
   *  renamed folder) or unreadable. */
  error?: string
  children: LaunchDirChild[]
}

export interface LaunchDirsAnswer {
  ok: boolean
  /** `launch.dirs` is `"*"`/unset: anything is allowed, nothing to enumerate. */
  wildcard: boolean
  /** `launch.dirs` is empty: nothing can be launched. */
  locked: boolean
  /** The machine's `allow_remote_launch` for the answering cwd. */
  remoteLaunch: boolean
  /** Refusal code, e.g. `unknown_peer`. */
  code?: string
  roots: LaunchDirRoot[]
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function childrenOf(value: unknown): LaunchDirChild[] {
  if (!Array.isArray(value)) return []
  const out: LaunchDirChild[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const path = str((entry as Record<string, unknown>).path)
    const name = str((entry as Record<string, unknown>).name)
    if (path) out.push({ path, name: name ?? path.split("/").pop() ?? path })
  }
  return out
}

/**
 * Decode `session_launch_dirs_result` without trusting it. A machine speaking an
 * older (or newer) protocol answers with something else or not at all; that must
 * leave the form working with a typed path, not throw.
 */
export function parseLaunchDirs(
  ub: Record<string, unknown>,
): LaunchDirsAnswer | null {
  if (typeof ub !== "object" || ub === null) return null
  if (ub.type !== "session_launch_dirs_result") return null
  const roots: LaunchDirRoot[] = []
  for (const entry of Array.isArray(ub.roots) ? ub.roots : []) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const path = str(record.path)
    if (!path) continue
    roots.push({
      path,
      name: str(record.name) ?? path.split("/").pop() ?? path,
      exists: record.exists !== false,
      truncated: record.truncated === true,
      ...(str(record.error) ? { error: str(record.error) } : {}),
      children: childrenOf(record.children),
    })
  }
  return {
    ok: ub.ok !== false,
    wildcard: ub.wildcard === true,
    locked: ub.locked === true,
    remoteLaunch: ub.remote_launch !== false,
    ...(str(ub.code) ? { code: str(ub.code) } : {}),
    roots,
  }
}

/**
 * Everything the picker may offer, flattened: the roots themselves (launching
 * straight into a configured root is legitimate) and one level below each. Used
 * to recognise a path the user pasted or typed as a PICK. Paths come from the
 * machine, so they are already the canonical absolute form. Display order, not
 * config order — see `sortedRoots`.
 */
export function dirChoices(answer: LaunchDirsAnswer): LaunchDirChild[] {
  const out: LaunchDirChild[] = []
  for (const root of sortedRoots(answer)) {
    // A configured root that is not on the machine is shown in the group list
    // (with the reason), but must not be offered as a value it would refuse.
    if (!root.exists) continue
    out.push({ path: root.path, name: root.name })
    out.push(...root.children)
  }
  return out
}

/**
 * The roots a given path sits under, so the list can open itself to whatever
 * the field already holds. A path typed or pasted into the field should not
 * hide behind a closed group; the folder you have already chosen should be the
 * one row visibly marked.
 */
export function rootsCovering(
  answer: LaunchDirsAnswer,
  path: string,
): string[] {
  const cwd = path.trim().replace(/\/+$/, "")
  if (!cwd) return []
  return answer.roots
    .filter((root) => cwd === root.path || cwd.startsWith(`${root.path}/`))
    .map((root) => root.path)
}

/** One row of the VISIBLE folder list. */
export interface LaunchDirRow {
  path: string
  /** Always the WHOLE path: in a list under the field, `myai` next to `aichats` cannot say which root it came from. */
  label: string
  /** 0 = an allow-listed root, 1 = one folder inside it. */
  depth: 0 | 1
  /** False for a folder the machine cannot launch into — a root that is configured but not on the machine right now. */
  pickable: boolean
  /** A root with folders one level down: tapping it opens them as well as choosing it. */
  expandable: boolean
  expanded: boolean
  /** How many folders sit one level down, so a closed root does not read as an empty one. */
  childCount: number
  /** The machine stopped listing after its own cap. */
  truncated: boolean
  /** Why the row is dimmed, in words. Nothing to act on — the launch would simply be refused. */
  note?: string
}

/**
 * The rows the panel paints — the ONE place the machine's folders are shown.
 *
 * The field above the list is a plain text input and stays editable; the list
 * is what you look at and tap. There is deliberately no `<datalist` on the
 * field: a second dropdown of the same 168 paths duplicates what is already on
 * screen, positions itself over the list it is repeating, and is the part that
 * is broken on phones in the first place (iOS Safari's `datalist` support is
 * partial — WebKit bug 305919 — and Chrome on Android will not open one for an
 * empty field). Typing filters these rows instead, so one control does what the
 * two used to.
 *
 * Groups are closed by default because the real allow-list is wide: measured on
 * the machine that reported the phone bug, 7 roots and 161 child folders, which
 * is a screen and a half of full paths. Roots are 7 lines, and the folders
 * under a root are already beside it.
 *
 * `filter` is what the field holds when it is NOT one of the offered paths —
 * half-typed text. A filter ignores `expanded` and shows every match in place,
 * with its root kept above it as a header, because a match like
 * `…/colt3k/2fasdec` is meaningless without the root it sits in. An EXACT path
 * is not a filter: the panel then browses normally (and opens that group), so
 * picking a folder does not collapse the list to one row.
 */
export function dirRows(
  answer: LaunchDirsAnswer,
  expanded: ReadonlySet<string>,
  filter = "",
): LaunchDirRow[] {
  const needle = filter.trim().toLowerCase()
  const out: LaunchDirRow[] = []
  for (const root of sortedRoots(answer)) {
    const open = expanded.has(root.path)
    const matches = (path: string) => path.toLowerCase().includes(needle)
    const kids = needle
      ? root.children.filter((child) => matches(child.path))
      : root.children
    const filtered = needle !== ""
    if (filtered && !matches(root.path) && kids.length === 0) continue
    out.push({
      path: root.path,
      label: root.path,
      depth: 0,
      pickable: root.exists,
      expandable: root.children.length > 0,
      expanded: filtered ? kids.length > 0 : open,
      childCount: root.children.length,
      truncated: root.truncated,
      ...(!root.exists
        ? { note: root.error ?? "not on this machine right now" }
        : filtered && kids.length > 0 && !matches(root.path)
          ? // The header of a filtered group: it is here for context, and the
            // count says how much of it the filter kept — `49 inside` over 3
            // rows would read as a list that lost its folders.
            { note: `${kids.length} of ${root.children.length} match` }
          : root.truncated
            ? { note: "listed only part-way" }
            : {}),
    })
    if (filtered ? kids.length === 0 : !open) continue
    // `sortedRoots` has ordered them; do not reorder here.
    for (const child of kids) {
      out.push({
        path: child.path,
        label: child.path,
        depth: 1,
        pickable: true,
        expandable: false,
        expanded: false,
        childCount: 0,
        truncated: false,
      })
    }
  }
  return out
}

/**
 * Case-insensitive folder ordering, and DETERMINISTIC at that.
 *
 * `localeCompare(b, undefined, { sensitivity: "base" })` ignores case but then
 * calls `apple` and `Apple` EQUAL, and `Array.sort` is stable — so an equal
 * pair keeps whatever order the machine's `readdirSync` happened to yield, and
 * a list ends up with `dev` before `GoLang` one run and the other way next.
 * Folding first is not enough; the tie has to be broken on purpose.
 */
export function compareFolders(a: string, b: string): number {
  const folded = a.localeCompare(b, undefined, { sensitivity: "base" })
  if (folded !== 0) return folded
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The roots and their children in the order an app should SHOW them: by FULL
 * PATH, ignoring case.
 *
 * The wire keeps `launch.dirs` in the order the user wrote it (that is what
 * `launchDirAllowed` sees, and it is theirs to reason about); the picker is a
 * display, and a display that follows config order looks broken when the
 * allow-list was written by hand over years.
 *
 * Full path, not last component: allow-list roots sit at different depths
 * (`~/dev/myai` next to `~/workdev/GoLang/src/x`), and ordering by the leaf
 * scatters one family across the list — `.../src/zeta` files under Z in a tree
 * that started under G. Paths are unique, so no tiebreak after this is needed.
 */
export function sortedRoots(answer: LaunchDirsAnswer): LaunchDirRoot[] {
  return answer.roots
    .map((root) => ({
      ...root,
      children: [...root.children].sort((a, b) =>
        compareFolders(a.path, b.path),
      ),
    }))
    .sort((a, b) => compareFolders(a.path, b.path))
}

/**
 * The name field after a folder is chosen: the new folder's last component, or
 * `null` for "leave it alone".
 *
 * Choosing a DIFFERENT folder means choosing a different project, so the name
 * follows the choice — unless the user has typed a name of their own, in which
 * case only OUR last suggestion is safe to replace. `previous` is the value this
 * function last handed back.
 */
export function nextAutoName(
  path: string,
  current: string,
  previous: string,
): string | null {
  const name = launchNameFor(path)
  if (!name) return null
  const typed = current.trim()
  if (!typed || typed === previous) return name
  return null
}

/**
 * The name to pre-fill from a chosen folder: its LAST component.
 *
 * `/Users/gfcollin/x/a/b/c` → `c`. The field stays editable — this is a
 * starting point taken from what the user just picked, not a decision made for
 * them (pi names a session after the project, and the project is the folder).
 */
export function launchNameFor(path: string): string {
  // Trailing slashes are the user's typing, not part of the name.
  const trimmed = path.trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const last = trimmed.split("/").pop() ?? ""
  // `~` and `/` name nothing worth pre-filling; neither does a bare drive-ish
  // prefix. Empty means "leave the field alone".
  if (!last || last === "~" || last === ".") return ""
  return last
}

/**
 * One line saying what the list is NOT, because a short list is otherwise
 * indistinguishable from a broken one. Empty when there is nothing to explain.
 */
export function dirsHint(answer: LaunchDirsAnswer): string {
  if (!answer.ok) {
    return answer.code === "unknown_peer"
      ? "this browser is no longer paired with that machine — pair it again to launch"
      : "the machine refused to list its launchable folders"
  }
  if (answer.wildcard)
    return 'this machine allows launch into ANY folder (launch.dirs is "*") — type a path'
  if (answer.locked)
    return "this machine's launch.dirs is empty, so no folder can be launched into — add one to ~/.pi/agent/extensions/un-bien.json"
  if (!answer.remoteLaunch)
    return "remote launch is turned off on this machine (defaults.allow_remote_launch) — a folder here would still be refused"
  if (answer.roots.length === 0)
    return "the machine answered, but none of its launch.dirs folders exist on it right now"
  const missing = answer.roots.filter((r) => !r.exists).length
  const cut = answer.roots.filter((r) => r.truncated).length
  const notes: string[] = []
  if (missing)
    notes.push(
      `${missing} allow-listed folder${missing > 1 ? "s" : ""} not on the machine right now`,
    )
  if (cut) notes.push("some folders are listed only part-way")
  return notes.join(" · ")
}
