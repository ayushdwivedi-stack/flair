- **The shared Renovate preset groups github/codeql-action MAJOR updates into one PR.**

  CodeQL rejects mixed versions across init, autobuild and analyze, so the action
  and its sub-actions must bump together. The preset's "Major updates land as
  their own PRs" rule left a codeql-action major ungrouped, and Renovate could
  open a separate PR per sub-action, each of which failed CodeQL. A rule scoped
  to the major groups them under one name. Non-major codeql-action updates keep
  the existing `github-actions` group.
