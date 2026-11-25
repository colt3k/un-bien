// defineConfig from vitest/config so the `test` block below type-checks.
import { defineConfig } from "vitest/config"
import { readFileSync } from "node:fs"
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

/**
 * Opt-in TLS, for the fallback path only (`scripts/https.sh mkcert`).
 *
 * The default https deployment does NOT need this: `tailscale serve`
 * terminates TLS at the edge with the node's `.ts.net` certificate and proxies
 * plain http to this port, so the browser sees https and Vite never holds a
 * key. Serving TLS here is the off-tailnet fallback, where something has to
 * hold the cert.
 *
 * Both variables or neither. A cert without a key would otherwise produce a
 * server that starts, looks fine, and is refused by every browser.
 */
const tlsKey = process.env.UNBIEN_TLS_KEY
const tlsCert = process.env.UNBIEN_TLS_CERT
const https =
  tlsKey && tlsCert
    ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }
    : undefined

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
  // The QR decoder is CJS and is only reached through a dynamic import, so the
  // dev server does not see it until someone scans — and discovering a new dep
  // mid-session makes Vite re-optimize and FULL-RELOAD the page, which lands
  // after the camera closed and throws the photo away. Naming it here pre-
  // bundles it at startup. Production does not care: the build splits it into
  // its own chunk either way.
  optimizeDeps: { include: ["jsqr"] },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  // The tests run in node, but through Vite's resolver, so the shims above are
  // what the tests actually load — the same module graph the browser gets.
  test: {},
  // A TAILNET IS AN OPTION, NOT A REQUIREMENT. Two supported ways to reach this
  // from a phone, and neither is mandatory:
  //   - same LAN: an address like http://192.168.1.86:5173. Vite allows any IP
  //     host header unconditionally (verified against vite's own isHostAllowed:
  //     ipv4/ipv6 return true before allowedHosts is consulted), so this needs
  //     no configuration at all. A hostname like `my-mac.local` does,
  //     because mDNS names are NOT IPs and would otherwise get 403'd.
  //   - a mesh VPN (Tailscale/Headscale/etc): http://<node>.<tailnet>.ts.net.
  // `host: true` binds every interface either way; allowedHosts stays a list
  // rather than `true` so the DNS-rebinding protection Vite added for this
  // still applies to everything else. Dev-server only — see README for serving
  // this properly.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: [".ts.net", ".local", "localhost"],
    https,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    allowedHosts: [".ts.net", ".local", "localhost"],
    https,
  },
})
