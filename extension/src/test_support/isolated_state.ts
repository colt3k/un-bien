/**
 * Import FIRST in a test file that loads the extension (index.js) or starts a
 * mesh node with default paths. It points the un-bien state root at a fresh
 * temp directory before session/global_config.ts resolves its paths at import.
 *
 * Without it, vitest.setup.ts has unset UNBIEN_STATE_DIR, so the state root
 * falls back to the developer's real one (~/.local/state/un-bien) and the
 * tests' mesh brokers open the SAME sockets the developer's live pi sessions
 * use: test agents join the live mesh (peer_joined/peer_left reach real
 * agents, names collide as #2), and tests pass or fail with whatever is
 * running. A test that sets UNBIEN_STATE_DIR itself still overrides it.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env["UNBIEN_STATE_DIR"] = mkdtempSync(
  join(tmpdir(), "unbien-test-state-"),
)
