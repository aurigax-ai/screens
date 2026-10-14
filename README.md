# screens

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

## Install

```sh
pnpm add -g @aurigax-ai/screens
```

## CLI in brief

```sh
screens create --allow example.com     # prints a screen id, an agent token and a viewer token
export SCREENS_TOKEN=<agent token>
screens screenshot <id> > shot.png
screens launch <id> google-chrome-stable https://example.com
screens click <id> 640 400
screens type <id> 'hello'
screens key <id> Return
screens list                           # ids, size, owner and state; never a token
screens stop <id>
screens mcp --screen <id>              # MCP stdio server with a `computer` tool
```

Exit codes: 0 ok, 2 usage, 3 not found, 4 refused (token, input owner, limit), 5 backend failure.
`--json` prints one JSON object.

The daemon starts on the first command and listens on `$XDG_RUNTIME_DIR/screens/daemon.sock`.
At most `maxScreens` screens run at once (default 4, 1 to 16, set in
`~/.config/screens/config.json`).

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
