// Import order is load-bearing: the polyfills must run before anything pulls in
// the un-bien client core, which uses `Buffer` at module scope.
import "./polyfills.js"
import "./styles.css"
import { App } from "./app.js"

new App()
