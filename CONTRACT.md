# screens contract

This is the stable interface of `screens`: the CLI, the daemon socket protocol and the MCP server.
Clients build on it; changes to it are breaking changes.

## Tokens

`create` returns a screen id, an agent token and a viewer token (64 hex characters each). Every
screen verb needs one of that screen's tokens, from `--token` or `SCREENS_TOKEN` (the flag wins).
`list`, `create` and `daemon` need none. Tokens live only in the daemon's memory and in what `create`
printed; no other output shows one.

## Exit codes and errors

| Exit | Error code | Meaning |
|---|---|---|
| 0 | | ok |
| 2 | `usage` | unknown verb, missing or malformed argument (checked before the daemon is contacted) |
| 3 | `not-found` | no such screen (or window, for `focus`) |
| 4 | `refused` | wrong or missing token, input owned by the human (`human-owns-input`), limit reached (`limit`) |
| 5 | `backend` | the screen or the daemon failed |

An error prints `screens: <message>` on stderr. With `--json` it also prints
`{"error":{"code":"<code>","message":"<message>"}}` on stdout.

## CLI

Coordinates are screen pixels, origin top left. `<keys>` is a key or a `+`-joined combination
(`Return`, `ctrl+s`, `alt+Tab`, `super+shift+F5`); `key` also takes several space-separated
combinations. Modifiers (`--modifiers`) are `shift`, `ctrl`, `alt`, `super` or a `+`-joined
combination of them.

| Verb | Arguments and flags | `--json` output |
|---|---|---|
| `create` | `[--width N] [--height N] [--allow DOMAIN]... [--label TEXT] [--lease] [--backend xvnc\|oci] [--runtime container\|podman\|docker]` (64 to 8192, default 1280x800) | `{"id","agentToken","viewerToken","width","height","backend","runtime"?}` |
| `list` | | `{"screens":[{"id","width","height","label","owner","state","backend","runtime"?}]}` |
| `stop <id>` | | `{"id"}` |
| `screenshot <id>` | `[--out FILE] [--max-side N]` | `{"width","height","png"}` (base64); without `--json` the PNG goes to `--out` or stdout |
| `zoom <id> <x0> <y0> <x1> <y1>` | `[--out FILE] [--max-side N]` | as `screenshot`: the region scaled to fit the screenshot size |
| `click <id> [<x> <y>]` | `[--button left\|middle\|right] [--count 1-3] [--modifiers KEYS] [--down \| --up]` | `{}` |
| `move <id> <x> <y>` | | `{}` |
| `drag <id> <x0> <y0> <x1> <y1>` | `[--modifiers KEYS]` | `{}` |
| `scroll <id> <up\|down\|left\|right> <amount> [<x> <y>]` | `[--modifiers KEYS]` (amount 1 to 100) | `{}` |
| `type <id> <text>` | | `{}` |
| `key <id> <keys>` | `[--repeat N]` (1 to 100) | `{}` |
| `hold-key <id> <keys> <seconds>` | seconds 0 to 300 | `{}` |
| `cursor <id>` | | `{"x","y"}` |
| `launch <id> -- <program> [args...]` | argv only, never a shell string | `{"pid"}` |
| `windows <id>` | | `{"windows":[{"id","name","x","y","width","height"}]}` |
| `focus <id> <window>` | a window id from `windows` | `{}` |
| `log <id>` | | `{"entries":[{"time","verb",...}]}` newest 500 |
| `events <id>` | | one JSON object per line until the screen stops |
| `view <id>` | viewer token only | the RFB stream on stdin/stdout; prints `viewer <viewer-id>` on stderr |
| `takeover <id> <viewer-id>` | viewer token only | `{"owner":"human"}` |
| `giveback <id> <viewer-id>` | viewer token only, from the viewer that took over | `{"owner":"agent"}` |
| `allow <id> <host>` | viewer token only | `{"host","allow":true}` |
| `deny <id> <host>` | viewer token only | `{"host","allow":false}` |
| `mcp --screen <id>` | token from `SCREENS_TOKEN` | MCP stdio server |
| `daemon run\|stop\|status` | | `status`: `{"pid","screens","maxScreens"}` |

`click` without coordinates clicks at the cursor. `--down` and `--up` press or release the button
without the other half. `list` text output is one line per screen: `id`, `WxH`, owner, state,
label, backend, separated by tabs.

States are `starting`, `running` and `stopping`; the owner is `agent` or `human`.

Log entries carry `time` (ISO 8601), `verb` and, per verb, `x`/`y`, `button`, `count`,
`modifiers`, `from`/`to`, `direction`/`amount`, `keys`/`repeat`/`duration`, `program` (for
`launch`, the program name only), `window`; `type` records only `length`, never the text.

## Daemon socket

The daemon listens on `$XDG_RUNTIME_DIR/screens/daemon.sock` (folder 0700, socket 0600). Any CLI
command starts it when it is not running. A client must refuse a path that is not a socket.

One request per connection: the client writes one JSON object and a newline; the daemon answers
with one JSON line and closes. Success is `{"ok":true, ...fields}` with the fields of the CLI's
`--json` output; failure is `{"ok":false,"code":"usage|not-found|refused|backend","message"}`.

Screen verbs carry `"id"` and `"token"`. Request fields:

| `verb` | Fields |
|---|---|
| `list` | |
| `create` | `width?`, `height?`, `allow: string[]`, `label: string`, `lease?: true`, `backend?`, `runtime?` |
| `stop`, `cursor`, `windows`, `log`, `events` | |
| `screenshot` | `maxSide?` |
| `zoom` | `region: [x0, y0, x1, y1]`, `maxSide?` |
| `click` | `at?: [x, y]`, `button`, `count`, `modifiers: string`, `press: "click"\|"down"\|"up"` |
| `move` | `to: [x, y]` |
| `drag` | `from: [x, y]`, `to: [x, y]`, `modifiers` |
| `scroll` | `direction`, `amount`, `at?: [x, y]`, `modifiers` |
| `type` | `text` |
| `key` | `keys`, `repeat` |
| `hold-key` | `keys`, `duration` (seconds) |
| `launch` | `argv: string[]` |
| `focus` | `window` (digits) |
| `view` | (viewer token) |
| `takeover`, `giveback` | `viewer` (a viewer id from `view`), viewer token |
| `allow`, `deny` | `host`, viewer token |
| `daemon-status`, `daemon-stop` | |

## Leases

`create` with `"lease": true` (`--lease` in the CLI) keeps the connection open after its answer.
When that connection closes for any reason (the client exits, crashes or is killed), the screen
stops as with `stop`; when the screen stops another way, the daemon closes the connection.
`screens create --lease` prints the answer and keeps running, holding the lease, until it is
killed or the screen stops. A screen without a lease is unchanged.

## Viewers and the input owner

Each screen has an input owner, `agent` at create or `human`. A `view` request with the viewer
token answers `{"ok":true,"viewer":"<viewer-id>"}` and a newline; from then on the connection is
a plain RFB 3.8 stream to the screen (security None, shared), for a client such as noVNC.
Everything the server sends is passed through. Of what the viewer sends, input (pointer, key,
clipboard, QEMU extended key events) reaches the screen only while that viewer holds the input;
desktop resize and xvp requests are always dropped; an unknown message type closes the viewer.

`takeover` with the viewer token and a live viewer id of that screen gives the input to that
viewer (owner `human`); another viewer's `takeover` moves it. `giveback` from the viewer that holds
it returns it to the agent (owner `agent`); from any other viewer it is refused. A viewer that
holds the input and disconnects gives it back. While the owner is `human`, every agent input verb
(`click`, `move`, `drag`, `scroll`, `type`, `key`, `hold-key`, and the MCP input actions) answers
`refused` with `human-owns-input` and does nothing; screenshots, `zoom`, `cursor`, `windows` and
`log` keep working. The agent token never opens a viewer or switches the owner.

## Backends

`xvnc` (Linux only, the Linux default): the screen runs in a sandbox-runtime wrap on the host.
`oci` (the only backend on macOS): the screen is a container of the screen image, run by Apple
`container`, Podman or Docker. `defaultBackend` (`"xvnc"` or `"oci"`) in the config file changes
the Linux default; `--backend xvnc` on macOS is a usage error. The runtime is detected once per
daemon (macOS: Apple `container`, then Docker; Linux: Podman, then Docker); `--runtime` overrides
it. No runtime that answers: `create` exits 5 and says what to install. `runtime` in `create` and
`list` names the runtime of an `oci` screen.

A container screen has no network, no host mounts, no published ports and no capabilities, runs
with no-new-privileges, a read-only root, a tmpfs `/tmp`, 2 GB of memory, 2 CPUs and at most 1024
processes, and carries the labels `screens.id` and `screens.daemon`. Everything between the daemon
and the container goes over the container's stdin and stdout. Its web traffic goes through the
same allowlist and domain requests as an `xvnc` screen. Inside it, `chromium`,
`google-chrome-stable` and `google-chrome` start Chromium with its own sandbox (a seccomp profile
derived from the runtime's default allows `chroot`); where the sandbox cannot run, `launch` of a
browser exits 5 and starts nothing. The image comes from `SCREENS_OCI_IMAGE`;
`SCREENS_OCI_SECCOMP` replaces the derived seccomp profile. On start, the daemon removes leftover
containers that carry its own `screens.daemon` label; it never touches other containers.

## Network

A screen reaches only the hosts given with `--allow` at `create` (srt domain patterns, e.g.
`example.com`, `*.example.com`, `localhost`). A request to any other host waits: subscribers get
one `domain-request` event per host, and the request goes on when `allow` answers it, or is refused
on `deny` or when nobody answers within 60 s. The answer (an unanswered request counts as a deny)
holds for every later request to that host from that screen until the screen stops; it applies to
that screen only and is never written anywhere. Answers may also be given before any request. Only
the viewer token answers.

## Limits and stop

At most `maxScreens` screens of both backends run at once: default 4, set only in
`$XDG_CONFIG_HOME/screens/config.json` (`~/.config/screens/config.json`) as
`{"maxScreens": N}`, 1 to 16. A value outside that range, or a file that is not JSON, makes the
daemon use the default and say so on its stderr. One `create` more answers `refused` with
`limit: ...` and starts nothing.

`stop` sends SIGTERM to every process of the screen, waits up to 4 s for them to exit, kills the
rest, and removes the screen folder; it returns within 5 s. Stopping the daemon stops every screen
first.

## Events

`events` keeps the connection open: the first line is the usual answer, then one event object per
line: `{"type":"owner","id","owner"}` when the input owner changes,
`{"type":"domain-request","id","host","port"}` when the screen asks for a host,
`{"type":"domain-answer","id","host","allow"}` when it is answered (or times out), and
`{"type":"stopped","id"}`, which ends the stream. Later steps add event types; clients ignore types
they do not know.

## MCP

`screens mcp --screen <id>` serves three tools:

- `computer`: `action` is one of `screenshot`, `zoom`, `left_click`, `right_click`,
  `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`,
  `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll`, `type`, `key`, `hold_key`,
  `wait`, with the arguments of `computer_toolset_20260801`: `coordinate`, `start_coordinate`,
  `text` (typed text, keys, or click/drag/scroll modifiers), `scroll_direction`, `scroll_amount`,
  `repeat`, `duration`, `region`. Screenshots are PNG images scaled so the longest side is at most
  1280 pixels; every coordinate and region is in that space. `zoom` returns the region scaled to
  the screenshot size. `cursor_position` answers `X=<x>, Y=<y>`; the other input actions answer
  `OK`.
- `screen_launch`: `{"argv": string[]}`, answers `started pid <pid>`.
- `screen_windows`: answers `{"windows":[...]}` as text.

A failure (wrong token, human owns input, bad arguments) is a tool result with `isError: true`.
