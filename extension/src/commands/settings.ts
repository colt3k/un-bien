/**
 * `/unbien settings` — edit un-bien's settings in pi, with pi's own settings
 * components (SettingsList, as in pi's /settings):
 *
 *  - This machine: the global config (`<agent dir>/extensions/un-bien.json`).
 *  - This folder: the per-cwd config (`<cwd>/.pi/un-bien/config.json`).
 *
 * Each row shows the value in effect (a default when the key is unset) and
 * says when a change needs a restart or reinstall. Lists (`launch.dirs`,
 * `service.env`) and the identity backend stay in the file: the identity row
 * is shown but not editable, as switching the key store is where pairing can
 * break.
 */
import {
  getSettingsListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import {
  Container,
  Input,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui"
import {
  isValidRelayUrl,
  isWebSocketScheme,
  loadConfig,
  saveConfig,
  type UnBienConfig,
} from "../config.js"
import {
  effectiveAllowRemoteLaunch,
  effectiveAllowRemoteTerminate,
  effectiveAutoStartRelay,
  loadLocalConfig,
  resolveAgentName,
  saveLocalConfig,
} from "../session/local_config.js"
import type { CommandDeps } from "./deps.js"

type Theme = Parameters<Parameters<ExtensionContext["ui"]["custom"]>[0]>[1]

const ON = "on"
const OFF = "off"
const onOff = (v: boolean): string => (v ? ON : OFF)

/** Merge `patch` into one section of the global config (saveConfig itself
 *  replaces whole top-level keys). An undefined value removes the key. */
function setGlobal<
  S extends "defaults" | "launch" | "mesh" | "subagents" | "debug" | "service",
>(section: S, patch: NonNullable<UnBienConfig[S]>): void {
  const current = (loadConfig()[section] ?? {}) as object
  saveConfig({ [section]: { ...current, ...patch } } as Partial<UnBienConfig>)
}

interface TextRow {
  id: string
  label: string
  description: string
  current: () => string
  /** Shown when the setting is unset. */
  fallback: string
  /** Why `value` is not acceptable, or null to save it. */
  check?: (value: string) => string | null
  save: (value: string) => void | Promise<void>
}

/** A row whose value is typed: the submenu is an Input. It is not prefilled
 *  (Input cannot put its cursor at the end of a set value); the prompt shows
 *  the current value, and Enter on an empty field keeps it. */
function textItem(theme: Theme, row: TextRow): SettingItem {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    currentValue: row.current() || row.fallback,
    submenu: (_value, done) => {
      const error = new Text("", 1, 0)
      const input = new Input()
      input.focused = true
      input.onSubmit = async (value) => {
        const v = value.trim()
        if (!v) return done()
        const problem = row.check?.(v) ?? null
        if (problem) {
          error.setText(theme.fg("error", problem))
          return
        }
        await row.save(v)
        done(v)
      }
      input.onEscape = () => done()
      const box = new Container()
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `${row.label}, now ${row.current() || row.fallback}. Enter saves; empty keeps it; Esc cancels:`,
          ),
          1,
          0,
        ),
      )
      box.addChild(input)
      box.addChild(error)
      return {
        render: (w: number) => box.render(w),
        invalidate: () => box.invalidate(),
        handleInput: (data: string) => input.handleInput(data),
      } satisfies Component
    },
  }
}

function list(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  done: () => void,
): SettingsList {
  return new SettingsList(
    items,
    Math.min(items.length + 2, 18),
    getSettingsListTheme(),
    onChange,
    done,
  )
}

/** This machine: the global config. */
function machineSettings(theme: Theme, done: () => void): Component {
  const g = loadConfig()
  const items: SettingItem[] = [
    textItem(theme, {
      id: "relay",
      label: "Relay URL",
      description:
        "The relay this machine connects to (http:// or https://). Applies after /unbien relay stop and start.",
      current: () => loadConfig().relay ?? "",
      fallback: "unset",
      check: (v) => {
        if (isWebSocketScheme(v))
          return "Use http:// or https:// (the WebSocket form is derived)."
        if (!isValidRelayUrl(v)) return "Must start with http:// or https://"
        return null
      },
      save: (v) => saveConfig({ relay: v }),
    }),
    {
      id: "defaults.auto_start_relay",
      label: "Auto-start (default)",
      description:
        "Join the mesh and start the relay when pi starts, in folders that don't set it.",
      currentValue: onOff(g.defaults?.auto_start_relay !== false),
      values: [ON, OFF],
    },
    {
      id: "defaults.allow_remote_launch",
      label: "Allow remote launch (default)",
      description:
        "Let a paired app start new pi sessions, in folders that don't set it. Off unless enabled.",
      currentValue: onOff(g.defaults?.allow_remote_launch === true),
      values: [ON, OFF],
    },
    {
      id: "defaults.allow_remote_terminate",
      label: "Allow remote terminate (default)",
      description:
        "Let a paired app end sessions it can see, in folders that don't set it.",
      currentValue: onOff(g.defaults?.allow_remote_terminate !== false),
      values: [ON, OFF],
    },
    {
      id: "launch.backend",
      label: "Launch backend",
      description: "Where app-launched sessions run.",
      currentValue: g.launch?.backend ?? "tmux",
      values: ["tmux", "herdr", "rex"],
    },
    {
      id: "launch.fallback",
      label: "Launch fallback",
      description:
        "Used only when the backend is unavailable, never after a launch was attempted.",
      currentValue: g.launch?.fallback ?? "none",
      values: ["none", "tmux", "herdr", "rex"],
    },
    textItem(theme, {
      id: "launch.tmux_session",
      label: "tmux session",
      description: "The tmux session launched pis become windows of.",
      current: () => loadConfig().launch?.tmux_session ?? "",
      fallback: "un-bien",
      save: (v) => setGlobal("launch", { tmux_session: v }),
    }),
    textItem(theme, {
      id: "launch.rex_session",
      label: "Rex session",
      description: "The label of the Rex session launched pis go into.",
      current: () => loadConfig().launch?.rex_session ?? "",
      fallback: "un-bien",
      save: (v) => setGlobal("launch", { rex_session: v }),
    }),
    textItem(theme, {
      id: "launch.rex_bin",
      label: "Rex binary",
      description: "The rex binary to run.",
      current: () => loadConfig().launch?.rex_bin ?? "",
      fallback: "PATH, then the Rex app",
      save: (v) => setGlobal("launch", { rex_bin: v }),
    }),
    textItem(theme, {
      id: "launch.rex_server",
      label: "Rex server",
      description: "The Rex server endpoint. The launcher never starts one.",
      current: () => loadConfig().launch?.rex_server ?? "",
      fallback: "the local server",
      save: (v) => setGlobal("launch", { rex_server: v }),
    }),
    textItem(theme, {
      id: "launch.shell",
      label: "Launch shell",
      description: "The login shell remote launches run through.",
      current: () => loadConfig().launch?.shell ?? "",
      fallback: "$SHELL",
      save: (v) => setGlobal("launch", { shell: v }),
    }),
    {
      id: "subagents.rooms",
      label: "Subagents in the app",
      description:
        "Show each subagent as its own session in the app. Applies to new subagents.",
      currentValue: onOff(g.subagents?.rooms === true),
      values: [ON, OFF],
    },
    {
      id: "mesh.tools",
      label: "Mesh tools",
      description:
        "Let the model message other agents (agent_send, list_peers, …). Restart pi to apply.",
      currentValue: onOff(g.mesh?.tools !== false),
      values: [ON, OFF],
    },
    {
      id: "mesh.federation",
      label: "Federation",
      description:
        "Take part in relay federation (agents on other machines). The relay's own gate still applies.",
      currentValue: onOff(g.mesh?.federation !== false),
      values: [ON, OFF],
    },
    {
      id: "package_manager",
      label: "Package manager",
      description:
        "For un-bien's global installs. Default: the one pi's npmCommand names, else npm. Reinstall to apply.",
      currentValue: g.package_manager ?? "default",
      values: ["default", "npm", "bun", "pnpm"],
    },
    {
      id: "service.runtime",
      label: "Service runtime",
      description:
        "What runs the launcher service (an absolute path can be set in the file). Reinstall to apply.",
      currentValue: g.service?.runtime ?? "installer's",
      values: ["installer's", "node", "bun"],
    },
    {
      id: "debug.envelope",
      label: "Debug: envelope log",
      description: "Write the envelope debug log.",
      currentValue: onOff(g.debug?.envelope === true),
      values: [ON, OFF],
    },
    {
      id: "debug.panels",
      label: "Debug: panels log",
      description: "Write the panel bridge debug log.",
      currentValue: onOff(g.debug?.panels === true),
      values: [ON, OFF],
    },
    {
      id: "debug.launcher",
      label: "Debug: launcher log",
      description: "Verbose launcher log. Restart the launcher to apply.",
      currentValue: onOff(g.debug?.launcher === true),
      values: [ON, OFF],
    },
    {
      id: "debug.relay",
      label: "Debug: relay log",
      description: "Info-level relay log. Restart the relay to apply.",
      currentValue: onOff(g.debug?.relay === true),
      values: [ON, OFF],
    },
    {
      id: "identity.storage",
      label: "Identity storage",
      description:
        "Where this machine's key is kept. Change it in the file (see docs/identity.md): switching can break pairing.",
      currentValue: g.identity?.storage ?? "keychain",
    },
  ]
  return list(
    items,
    (id, value) => {
      const on = value === ON
      switch (id) {
        case "defaults.auto_start_relay":
          return setGlobal("defaults", { auto_start_relay: on })
        case "defaults.allow_remote_launch":
          return setGlobal("defaults", { allow_remote_launch: on })
        case "defaults.allow_remote_terminate":
          return setGlobal("defaults", { allow_remote_terminate: on })
        case "launch.backend":
          return setGlobal("launch", {
            backend: value as "tmux" | "herdr" | "rex",
          })
        case "launch.fallback":
          return setGlobal("launch", {
            fallback: value as "none" | "tmux" | "herdr" | "rex",
          })
        case "subagents.rooms":
          return setGlobal("subagents", { rooms: on })
        case "mesh.tools":
          return setGlobal("mesh", { tools: on })
        case "mesh.federation":
          return setGlobal("mesh", { federation: on })
        case "package_manager":
          return saveConfig({
            package_manager:
              value === "default"
                ? undefined
                : (value as "npm" | "bun" | "pnpm"),
          })
        case "service.runtime":
          return setGlobal("service", {
            runtime: value === "installer's" ? undefined : value,
          })
        case "debug.envelope":
          return setGlobal("debug", { envelope: on })
        case "debug.panels":
          return setGlobal("debug", { panels: on })
        case "debug.launcher":
          return setGlobal("debug", { launcher: on })
        case "debug.relay":
          return setGlobal("debug", { relay: on })
        default:
          // Text rows save from their submenu; identity is not editable.
          return undefined
      }
    },
    done,
  )
}

/** This folder: the per-cwd config. */
function folderSettings(
  theme: Theme,
  deps: CommandDeps,
  cwd: string,
  done: () => void,
): Component {
  const local = loadLocalConfig(cwd)
  const items: SettingItem[] = [
    textItem(theme, {
      id: "agent_name",
      label: "Agent name",
      description:
        "This agent's name on the mesh and in the app. Renames it now, as /unbien rename does.",
      current: () => resolveAgentName(cwd),
      fallback: "",
      save: (v) => deps.renameAgent(v),
    }),
    {
      id: "auto_start_relay",
      label: "Auto-start",
      description:
        "Join the mesh and start the relay when pi starts in this folder.",
      currentValue: onOff(effectiveAutoStartRelay(local)),
      values: [ON, OFF],
    },
    {
      id: "allow_remote_launch",
      label: "Allow remote launch",
      description: "Let a paired app start new pi sessions in this folder.",
      currentValue: onOff(effectiveAllowRemoteLaunch(local)),
      values: [ON, OFF],
    },
    {
      id: "allow_remote_terminate",
      label: "Allow remote terminate",
      description:
        "Let a paired app end sessions in this folder. Applies to sessions started after the change.",
      currentValue: onOff(effectiveAllowRemoteTerminate(local)),
      values: [ON, OFF],
    },
  ]
  return list(
    items,
    (id, value) => {
      const on = value === ON
      if (id === "auto_start_relay")
        saveLocalConfig(cwd, { auto_start_relay: on })
      else if (id === "allow_remote_launch")
        saveLocalConfig(cwd, { allow_remote_launch: on })
      else if (id === "allow_remote_terminate")
        saveLocalConfig(cwd, { allow_remote_terminate: on })
    },
    done,
  )
}

export async function _cmdSettings(
  deps: CommandDeps,
  ctx: ExtensionContext,
): Promise<void> {
  const cwd = ctx.cwd || process.cwd()
  await ctx.ui.custom<void>((_tui, theme, _kb, done) =>
    list(
      [
        {
          id: "machine",
          label: "This machine",
          description:
            "un-bien.json in pi's agent dir: relay, launch, mesh, installs, debug logs",
          currentValue: "",
          submenu: (_v, close) => machineSettings(theme, () => close()),
        },
        {
          id: "folder",
          label: "This folder",
          description: `.pi/un-bien/config.json in ${cwd}`,
          currentValue: "",
          submenu: (_v, close) =>
            folderSettings(theme, deps, cwd, () => close()),
        },
      ],
      () => undefined,
      () => done(),
    ),
  )
}
