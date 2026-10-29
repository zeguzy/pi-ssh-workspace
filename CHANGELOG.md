# Changelog

## 0.1.0

Initial release.

- Route `read`, `write`, `edit`, `bash` and `!` / `!!` shell commands to a remote host over SSH
  via `--ssh <host>`.
- `--ssh-cwd <path>` sets the remote working directory at startup; absolute, `~`-relative and
  home-relative paths are accepted. `host:path` combined form also works.
- `/ssh-cwd` shows the active remote directory; `/ssh-cwd <path>` switches it mid-session without
  restarting pi or reloading the session.
- Every switch is validated on the remote: the target must be an existing directory, and the stored
  value is the physical path from `pwd -P`. Failed switches keep the previous directory.
- Prefix-safe path mapping: paths inside the local workspace map into the remote root, paths outside
  it pass through unchanged.
- The structured system prompt's `cwd` section is rewritten to the remote root each turn, and the
  prompt states that local search tools and pi-lens do not see the remote tree. Only the changed
  sections are sent, so the prompt-cache prefix survives a switch.
- No `--ssh`: the extension is completely inert and all tools stay local.
