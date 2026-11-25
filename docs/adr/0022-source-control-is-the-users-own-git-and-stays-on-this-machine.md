# ADR 0022: Source control is the user's own git, and stays on this machine

**Status:** Draft
**Date:** 2026-11-19
**Decided by:** the agent's draft, written from step 8 of
[the audit's build plan](../VSCODE-AUDIT.md#the-build-plan); the user has
not reviewed it.

Under [ADR 0009](0009-nothing-is-lost-or-destroyed-without-a-say.md) and
[ADR 0020](0020-the-shell-does-what-vs-code-does-and-stays-its-own.md).

## Context

- Work on STARLIMS scripts is kept in git like other code, and the IDE
  showed nothing of it: not the branch, not what had changed.
- Git can be reached through a library or through the program itself.
- Some of what git does leaves the machine (fetch, pull, push), and some
  of it destroys work (discard, reset, a forced checkout).

## Decision

- **The backend runs the git that is on the machine.** No library is
  added. With no git, or outside a repository, the panel says so and the
  rest of the IDE is as it was.
- **Only what stays on this machine.** The IDE asks what has changed,
  reads a file as it was, stages, unstages, commits and discards. It does
  not fetch, pull or push. Git is given no keyboard and told not to ask
  at the terminal; what the user's own git is set up to do besides (sign
  a commit, run a filter) is theirs.
- **A file's name is a name.** Git is told to read every name as written,
  not as a pattern, and is asked from the workspace's folder for the file
  in it. A question git could not answer is an error, never a "no".
- **A workspace inside a larger repository sees its own folder.** A
  commit is the repository's and takes what is staged above the folder
  too; the panel says how many such files there are.
- **A commit is git's own.** It is made with the user's name as their git
  has it, and runs the checks their repository runs. When git refuses,
  the IDE shows git's words and changes nothing.
- **Nothing that was committed is rewritten.** There is no amend, no
  reset and no rebase here.
- **Discarding asks, and keeps a copy.** The safe answer is the default.
  The file as it was goes into its local history first. A file git does
  not follow goes to the trash, not out of existence.
- **A change is shown, not edited, beside what git has of it.** The file
  is edited in its own tab.
- **The margin compares with what is staged,** so that staging a change
  clears its marks, as in VS Code.

## Consequences

- Getting others' work, and sending one's own, is still done in a
  terminal or another tool.
- A commit made outside the IDE is seen only when the window is come back
  to, or a file changes.
- A repository's own checks run inside the IDE's commit and may take
  time; the button waits for them.
- Which git runs, and how it is set up, is the machine's business: a
  different git on another machine may answer differently.
