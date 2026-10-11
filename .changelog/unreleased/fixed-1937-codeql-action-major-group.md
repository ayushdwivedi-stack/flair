- **The shared Renovate preset groups github/codeql-action updates of every type, majors included, into one PR.**

  CodeQL rejects mixed versions across init, autobuild and analyze. The preset
  now groups the action and all of its sub-actions under one group name, so
  every update type — including a major — lands in a single pull request.
