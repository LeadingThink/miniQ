# Desktop PATH initialization

When the desktop shell starts `miniq-daemon`, it resolves the environment once
for the lifetime of that desktop process and passes only the resulting `PATH`
to the daemon.

- On macOS and Linux, miniQ runs the user's `SHELL` as an interactive login
  shell and reads the value printed after the shell configuration has loaded.
  The lookup has a two-second timeout. If the shell cannot start, exits with an
  error, times out, or does not return a PATH marker, miniQ starts normally and
  keeps the process PATH while logging a diagnostic. An unset `SHELL` also
  preserves the process PATH. Bash loads its login profile (`.bash_profile`,
  `.bash_login`, or `.profile`); `.bashrc` is loaded only if that profile sources
  it. Zsh loads its interactive/login configuration, including `.zshrc`.
  Fish exports its initialized PATH. Shell aliases and functions are not imported.
- On Windows, miniQ uses the PATH inherited from the Explorer process. It does
  not load a PowerShell profile. Changes to the user or system PATH require
  restarting miniQ (and, when applicable, the desktop session that launched
  it).

The resolved value is inherited by the daemon, so shell commands, Node plugin
hosts, and skill dependency checks use the same PATH. No other variables are
imported from the shell, and the existing subprocess environment allowlist is
unchanged.

The latest initialization status is saved to `logs/desktop-path.log` in the
miniQ data directory without recording PATH contents or shell output. Fully quit
miniQ (closing the window only hides it) and restart after changing shell
configuration. A daemon already running, including one started by the CLI,
retains its original environment until it is stopped and restarted; reconnecting
does not modify or interrupt that daemon's active tasks.
