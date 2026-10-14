# Rules for agents working in this repository

## The package

- `@aurigax-ai/screens` is a standalone package. It imports nothing from any client application
  and names none anywhere: code, tests, docs, package metadata. Clients depend on it, never the
  other way round. A test checks the import graph.
- TypeScript, strict, Node 22 or later, ES modules. pnpm only; never npm or npx. Biome formats and
  lints (2-space indent, single quotes, no semicolons unless needed, line width 100). Vitest runs
  the tests.
- `@anthropic-ai/sandbox-runtime` is a plain dependency at an exact version.

## Code

- The code has no comments. Names carry the what; the why goes in the PR description or here.
- Never block the event loop of a process that hosts the sandbox runtime (no `spawnSync`, no
  synchronous waits): its proxy runs on that loop and every request would stall.

## Security rules

- **The daemon only listens.** It never connects to, opens or follows a path a screen can write.
  Screens dial out to sockets the daemon owns in a folder the screen can read but not write. A
  file found where a daemon socket goes is unlinked, never followed.
- **A screen never reaches the user's session.** Each screen has its own X server, private `/tmp`,
  own network namespace, `HOME`, `TMPDIR`, `XDG_RUNTIME_DIR` and session bus. The user's home,
  `XDG_RUNTIME_DIR`, `/tmp`, the daemon's folders and every container socket the user can connect
  to (Docker, containerd, Podman, CRI-O: access to one is root on the host) are denied to it. Its
  environment holds only `PATH`, locale variables, what the sandbox runtime adds and the screen's
  own folders.
- **Apps start by argv only**, never from a shell string.
- **A screen's network is closed except its allowlist.** Answers to a screen's domain requests last
  until the screen stops, apply to that screen only and are never written anywhere.
- **Agent input goes in only while the agent owns the screen's input.** Only a viewer connection
  with the viewer token takes over or gives back.
- **Every screen has a cap and a stop.** `stop` ends the whole process tree within 5 s and removes
  the screen folder; nothing of a screen outlives it.

## Tests

- Every approved case has a test whose name starts with its ID (`SCR-C14 ...`). Never change an
  approved case's test to make it pass.
- Tests never touch the real display. No test uses `DISPLAY=:0` except the case that proves it is
  refused from inside a screen, and no test opens a window on the user's desktop.
- Nothing starts a browser or any X or Wayland client outside a screen, including by hand while
  debugging. A manual run uses the environment the test harness uses: `DISPLAY`,
  `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `DBUS_SESSION_BUS_ADDRESS` and
  `XAUTHORITY` removed, `XDG_RUNTIME_DIR` pointed at a scratch folder, and browsers started with
  `--ozone-platform=x11` against a display the run owns.
- No load or stress tests.
- Tests clean up every process and folder they start.

## Commits and pull requests

- Conventional commit subjects (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
- One branch and pull request per step, closing its issue. `ci-result` must be green to merge.
- No AI co-author trailer and no "Generated with" line in commits or pull requests.

## Design notes

- One daemon per user listens on `$XDG_RUNTIME_DIR/screens/daemon.sock`. Clients refuse a path
  that is not a socket; the daemon unlinks whatever it finds there before it listens.
- Each screen lives in `<state>/<id>/` (`$XDG_STATE_HOME/screens`): `screen/` is the only folder
  the screen may write; `link/` holds the daemon's listening sockets (`launch.sock`, `rfb.sock`)
  and is read-only inside; `bridge/` is the sandbox runtime's `TMPDIR`. The runtime bind-mounts
  its proxy bridge sockets before its filesystem rules, so a denied parent would hide them:
  `bridge/` is therefore readable inside the screen. It holds only those sockets.
- Each screen is one sandbox-runtime host process (`screen-host`), forked by the daemon. The wrap
  starts with a minimal environment (`PATH`, locale) so nothing of the caller's environment reaches
  the screen.
- `screens-init` starts first inside the wrap: Xvnc on `/tmp/screens/rfb.sock` in the screen's
  private `/tmp`, the proxy forwarder, then it connects out to `link/launch.sock`. The daemon
  accepts one connection there and closes later ones; it accepts an `rfb.sock` connection only
  when it asked for one. Everything a screen sends is untrusted.
- The daemon's RFB client announces only the Raw encoding, so Xvnc draws the pointer into the
  framebuffer: screenshots show the pointer.
- Tokens are 32 random bytes in hex, so they never start with `-`.
