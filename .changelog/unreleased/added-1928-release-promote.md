- **A privileged `release-promote` workflow moves `latest` after the npm approval.**
  The unprivileged poll dispatches it on the version's tag ref once every lockstep
  package is public and hashes to the certified digest. It first verifies the promote
  boundary through the API: the `v*` tag rulesets are active, and the `release-promote`
  environment exists with a `v*`-only tag policy. The run executes the post-publish
  canary, then the promote block; with no environment reviewers configured, the npm
  approval stays the one human action.
  The poll does not redispatch a version whose run is visible in the run list, and
  dispatches each version at most once per poll; re-running a failed run is an
  operator step. If the boundary is missing, the poll dispatches nothing and fails
  when a ready version reaches the dispatch. GitHub runs the tag's copy of the
  workflow files, so those settings are the boundary. The workflow's
  own checks (executed files equal to the default branch's, repository scripts only
  from a pinned default-branch commit) are defence in depth. A version older than a
  package's `latest` at the block's pre-move read is refused before any tag moves.

  > **Heads-up:** a repository admin creates the `release-promote` environment once: a
  > deployment policy of exactly the tag pattern `v*` and an `NPM_TOKEN` with write
  > access to the lockstep packages (required reviewers are optional). Until then the poll
  > dispatches nothing. A manual dispatch with `dry_run` at its default validates
  > through block generation without testing the move.
