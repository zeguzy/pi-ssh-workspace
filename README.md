# pi-ssh-workspace

**Run [pi](https://github.com/earendil-works/pi)'s tools on a remote machine over SSH — and switch the remote working directory mid-session with `/ssh-cwd`.**

Model calls still leave from your laptop. Only file and shell work moves to the remote: `read`,
`write`, `edit`, `bash`, and your own `!` commands. That means your API keys, your model choice and
your local pi setup stay put, while the agent edits and builds inside the remote box you actually
deploy to.

```bash
pi install npm:pi-ssh-workspace
pi --ssh my-host --ssh-cwd /home/user/code/project
```

```text
/ssh-cwd                     # where am I on the remote?
/ssh-cwd ~/code/other        # move there; relative paths and ~ both work
```

---

## Why this exists

Most "remote dev" setups make you choose: either run the agent on the remote machine (and give up
your local models, keys, plugins and TUI), or run it locally (and give up the remote toolchain).
This extension splits the two. pi runs locally; the four file/shell tools run remotely.

The tricky part of that split is the working directory. In a long session you move around —
`backend/`, then `frontend/`, then a sibling checkout. Restarting pi to change directories loses the
conversation, so `/ssh-cwd` switches the remote root in place and tells the model what changed.

---

## Install

```bash
pi install npm:pi-ssh-workspace
```

Or from git:

```bash
pi install git:github.com/<your-account>/pi-ssh-workspace
```

Then start pi with `--ssh`. Without that flag the extension does nothing at all: every tool stays
local, and it costs you no behaviour change.

**Requires:** pi ≥ 1.1 (tested with 1.1.0) · Node.js ≥ 22.19 · SSH key auth to the remote · `bash` on the remote

---

## Usage

### Start a session on a remote workspace

```bash
pi --ssh my-host --ssh-cwd /home/user/code/project
```

| Flag | Meaning |
|---|---|
| `--ssh <host>` | SSH destination. Anything `ssh` accepts works: a `~/.ssh/config` alias, `user@host`, an IP. |
| `--ssh-cwd <path>` | Remote working directory. Absolute, `~`-relative, or relative to the remote home. Defaults to the remote `$HOME`. |

The combined form is also accepted:

```bash
pi --ssh user@host:/home/user/code/project
```

Prefer the two-flag form: it parses more predictably, and it keeps a `:port` suffix from being
mistaken for a path. Put ports in `~/.ssh/config` instead.

At startup the extension resolves the directory on the remote with `cd <dir> && pwd -P`. If that
fails — bad host, unreachable machine, missing directory — pi prints `SSH mode not enabled: <reason>`
and keeps running **locally**. Check that notice before trusting any edit in that session; see
[Known limits](#known-limits).

### Switch the remote directory while pi is running

```text
/ssh-cwd                          # print the active remote directory
/ssh-cwd /home/user/code/other    # absolute
/ssh-cwd ~/code/other             # ~ expands to the remote $HOME
/ssh-cwd subdir                   # relative to the current remote directory
/ssh-cwd ../other                 # .. works too
```

Every switch is validated on the remote before it is applied:

- the target must exist and be a **directory** (a file path is rejected)
- the stored value is the physical absolute path from `pwd -P`, never a `~` string or a symlink path
- a failed switch leaves the previous directory in place and reports the remote error
- switching to where you already are is a no-op with an `unchanged` notice

After a successful switch, `read`, `write`, `edit`, `bash` and `!` commands target the new
directory immediately, and pi receives a message telling the model that the root moved.

### Your own shell commands

`!` and `!!` in the pi prompt are routed to the remote too:

```text
!pwd              # remote directory, output goes into the model's context
!!git status      # remote, output stays out of context
```

---

## What runs where

This split is the whole point, so it is worth being precise:

| Runs on the **remote** | Runs on the **local** machine |
|---|---|
| `read`, `write`, `edit` | model calls and provider requests |
| `bash` | `ls`, `grep`, `find` (pi's own search tools) |
| `!` / `!!` shell commands | `process` (long-running process tool) |
| anything the model runs through `bash` | LSP diagnostics and code intelligence (pi-lens) |
| | your `~/.ssh/config`, keys, pi config and plugins |

The extension tells the model this explicitly on every turn, because the failure mode is subtle: a
local `grep` over a stale checkout looks like a successful search. The prompt therefore states that
local search tools do **not** see the remote tree, and that remote inspection should go through
`bash`.

### Path mapping

Tool arguments are resolved against the local directory pi was started in, then mapped into the
remote root. If you start pi in `/Users/you/code/project` and point `--ssh-cwd` at
`/home/user/code/project`, then:

| You (or the model) pass | The remote sees |
|---|---|
| `/Users/you/code/project/src/app.ts` | `/home/user/code/project/src/app.ts` |
| `src/app.ts` | `/home/user/code/project/src/app.ts` |
| `/etc/hosts` (outside the local root) | `/etc/hosts`, unchanged |

Paths outside the local workspace are passed through as-is, so absolute remote paths always work.

---

## Recommended SSH setup

The extension shells out to `ssh` with `BatchMode=yes`, so password and interactive-2FA prompts are
not supported — use keys, an agent, or an already-authenticated host. A connection-sharing setup
removes most of the per-call latency:

```sshconfig
Host my-host
    HostName 10.0.0.10
    User byteide
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

    ServerAliveInterval 15
    ServerAliveCountMax 3

    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
```

Verify it works non-interactively before starting pi:

```bash
ssh -o BatchMode=yes my-host 'printf "connected\n"; pwd'
```

### Cloud IDE / LAPS style hosts

Host aliases generated by cloud IDE tooling work the same way:

```bash
pi --ssh cloudide-wsd9e82240b9ecf39a --ssh-cwd /home/byteide/code/LAPS
```

---

## A practical alias

If you always land in the same remote workspace:

```bash
# ~/.zshrc
alias pi-remote='cd ~/code/project && pi --ssh my-host --ssh-cwd /home/user/code/project'
```

Then just `pi-remote`, and `/ssh-cwd` inside it when you need to move.

---

## Known limits

Being explicit about the current scope, because these are real:

- **No mirror or sync.** There is no local copy of the remote tree. `ls`/`grep`/`find` and pi-lens
  read your local checkout, which is not synchronized. Use remote `bash` to inspect remote files.
- **Only four tools are routed.** `process`, browser automation, pi-lens and other extensions keep
  running locally. Starting a dev server through `process` starts it on your laptop, not the remote.
  Use remote `bash` (or `!`) for that today.
- **No password or interactive-2FA auth.** `BatchMode=yes` is deliberate so a call can never hang
  waiting on a prompt.
- **One remote per session.** The host is fixed at startup; `/ssh-cwd` moves the directory, not the
  machine. Switching hosts means a new pi session.
- **The remote must look like the local tree.** Path mapping assumes the two workspaces have the
  same relative layout. Unrelated layouts need absolute remote paths.
- **A failed startup leaves you local.** If `--ssh` cannot resolve the directory, pi continues
  locally and says so. Nothing is silently remote, but nothing is silently *prevented* either — an
  edit in that session lands on your laptop. Read the startup notice.

---

## How it works

The extension is a thin wrapper around pi's own tools. pi exposes pluggable operations for each
tool, so the extension swaps the operations layer and keeps pi's schemas, validation, rendering and
truncation:

```text
pi read/write/edit/bash tool
        │
        ├─ no --ssh ─────────► local filesystem / local shell
        │
        └─ --ssh <host> ─────► ssh <host> '...'  (remote filesystem / remote shell)
```

`/ssh-cwd` updates one in-memory value. Because the operations layer is rebuilt from that value on
every call, the switch needs no restart and no session reload.

The extension also rewrites the `cwd` section of pi's structured system prompt, so the model's idea
of "where am I" matches the remote root. It patches the section rather than replacing the whole
prompt, which keeps the prompt-cache prefix intact across turns.

---

## Development

```bash
npm install
npm run check     # typecheck + tests
```

The test suite drives the real tool implementations through a fake `ssh` on `PATH`
(`test/fixtures/ssh-double.sh`) that runs the remote command locally in a temporary sandbox. That
exercises the full remote code path — quoting, path mapping, directory resolution, error handling —
without needing a server. Two phases run: `local` (no `--ssh`, everything must stay local) and `ssh`
(routing, `/ssh-cwd` semantics, prompt rewriting).

To try a local change in pi without installing:

```bash
pi --no-extensions -e ./src/index.ts --ssh my-host --ssh-cwd /path
```

---

## License

MIT
