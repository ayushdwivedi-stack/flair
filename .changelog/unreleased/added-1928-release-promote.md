- **A privileged `release-promote` workflow moves `latest` after the npm approval,
  so the approval is the only human action.** The unprivileged poll dispatches it on
  the version's tag ref once every lockstep package is public and hashes to the
  certified digest; it runs the post-publish canary first, then the promote block, from
  a tree fetched from the default branch, never from the tag.

  > **Heads-up:** an org admin creates the `release-promote` environment once — a `v*`
  > tag deployment policy and an `NPM_TOKEN` with write access to the lockstep packages.
  > Until then the job fails closed and moves nothing; a manual dispatch rehearses it
  > with `dry_run` at its default.
