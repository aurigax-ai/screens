# screens

**Alpha:** interfaces may change before 1.0.

Isolated desktops for agents. `screens` runs a per-user daemon that starts disposable Linux X
screens, each inside its own sandbox: its own X server, network namespace, `/tmp`, home and session
bus. An agent sees and drives a screen through a CLI or an MCP server; the screen never touches
your own display, input, focus, clipboard, session bus or files.

Linux first. Each screen is a [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
wrap holding Xvnc (Unix socket only), the apps and a small helper. Network access is closed except
for the domains you allow.

## Requirements

- Linux with unprivileged user namespaces
- Node.js 22 or later
- `bwrap` (bubblewrap), `rg` (ripgrep), `socat`, `Xvnc` (TigerVNC), `xdotool`, `dbus-run-session`
- A browser to run inside screens, such as `google-chrome-stable`
- For container screens (`--backend oci`, the only backend on macOS): rootless Podman or Docker
  (Docker Desktop, OrbStack, Colima), or Apple `container` on Apple silicon

## Install

```sh
pnpm add -g @aurigax-ai/screens
```

## CLI in brief

```sh
screens create --allow example.com     # prints a screen id, an agent token and a viewer token
export SCREENS_TOKEN=<agent token>
screens launch <id> -- google-chrome-stable https://example.com
screens screenshot <id> --out shot.png
screens click <id> 640 400
screens type <id> 'hello'
screens key <id> ctrl+l
screens windows <id>
screens list                           # ids, size, owner and state; never a token
screens stop <id>
```

Exit codes: 0 ok, 2 usage, 3 not found, 4 refused (token, input owner, limit), 5 backend failure.
`--json` prints one JSON object. The full contract (verbs, flags, JSON shapes, the daemon socket
protocol) is in [CONTRACT.md](CONTRACT.md).

The daemon starts on the first command and listens on `$XDG_RUNTIME_DIR/screens/daemon.sock`.
At most `maxScreens` screens run at once (default 4, 1 to 16, set in
`~/.config/screens/config.json`).

## MCP

`screens mcp --screen <id>` is an MCP stdio server for one screen, with the token in
`SCREENS_TOKEN`. It offers `computer` (the actions and arguments of Anthropic's
`computer_toolset_20260801`, screenshots scaled so the longest side is at most 1280 pixels and
coordinates in that space), `screen_launch` and `screen_windows`.

```json
{
  "mcpServers": {
    "screen": {
      "command": "screens",
      "args": ["mcp", "--screen", "<id>"],
      "env": { "SCREENS_TOKEN": "<agent token>" }
    }
  }
}
```

## Development

```sh
pnpm install
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run test:integration
```

See [AGENTS.md](AGENTS.md) for the rules every change follows.

## License

MIT
