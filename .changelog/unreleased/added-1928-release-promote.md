- **A privileged `release-promote` workflow moves `latest` after the npm approval.**
  Once its environment is configured, a successful run leaves the approval as the only
  human action; a failed run is not dispatched again and is re-run by hand. The
  unprivileged poll dispatches it on the version's tag ref once every lockstep package
  is public and hashes to the certified digest; it runs the post-publish canary, then
  the promote block. GitHub runs the tag's copy of the two workflow files, which must
  equal the default branch's. Once a job's tree selection succeeds, every repository
  script it runs, the canary's checks included, comes from the default branch at a
  pinned commit; a failed selection runs none. A version whose `latest` is already
  newer is refused before any tag moves.

  > **Heads-up:** an org admin creates the `release-promote` environment once — a `v*`
  > tag deployment policy and an `NPM_TOKEN` with write access to the lockstep packages.
  > Until then the job fails closed and moves nothing. A manual dispatch with `dry_run`
  > at its default validates through block generation without testing the move.
