// defineConfig from vitest/config so the `test` block below type-checks.
import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

/**
 * The web client does NOT re-implement the wire. It imports
 * `@geohar/un-bien/client` — the same transport, Ed25519 pairing crypto, base64
 * canonicalization and envelope framing the machine side runs — so the two ends
 * cannot drift. Three node-isms sit in that module graph, aliased here rather
 * than forked into a browser copy:
 *
 *   node:crypto   → src/shims/node-crypto.ts   (createHash sha256/sha512,
 *                                                randomBytes — that is all the
 *                                                core touches)
 *   node:events   → the `events` package       (RelayClient extends EventEmitter)
 *   ws            → src/shims/ws.ts            (native WebSocket behind ws's
 *                                                .on/.once/terminate surface)
 *   debug_log.js  → src/shims/debug-log.ts     (a FILE-backed diagnostic; the
 *                                                alias also stops the extension's
 *                                                config/paths/fs chain from
 *                                                entering the browser bundle)
 *
 * The alias for `debug_log.js` matches any relative specifier — the core imports
 * it both as `../session/debug_log.js` and `./debug_log.js`.
 */
const shim = (name: string): string =>
  fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        // Must match the WHOLE specifier: a regex alias replaces only what it
        // matches, so a partial match would splice the shim path onto the
        // leftover `../session/` prefix.
        find: /.*debug_log\.js$/,
        replacement: shim("debug-log.ts"),
      },
      { find: /^node:crypto$/, replacement: shim("node-crypto.ts") },
      // The `events` npm package, by path: Vite refuses to bundle the bare
      // specifier (it is on its browser-externalized list) and node's own
      // `events` is not browser-loadable.
      {
        find: /^node:events$/,
        replacement: fileURLToPath(
          new URL("./node_modules/events/events.js", import.meta.url),
        ),
      },
      { find: /^ws$/, replacement: shim("ws.ts") },
    ],
  },
  // `buffer` (and the core's Buffer use) assumes the node global exists.
  define: { global: "globalThis" },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {},
  // The tests run in node, but through Vite's resolver, so the shims above are
  // what the tests actually load — the same module graph the browser gets.
  server: {
    // Reachable from a phone on the same tailnet: bind every interface, and
    // allow any MagicDNS host (`m5max.tail5f1ece.ts.net`) past Vite's host
    // check. Dev-server only — see README for serving this properly.
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [".ts.net", "localhost"],
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    allowedHosts: [".ts.net", "localhost"],
  },
})
