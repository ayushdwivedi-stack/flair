- **An unconfirmed feed write records the id's outcome-unknown marker inside its lock, so later writes to that id answer `503 write_outcome_unknown` (flair#2806, flair#2807).**

  The ordinary `POST /FeedMemories` write-back records the marker before the
  lock is released when its committed-row read-back does not show the write —
  the `409 feed_write_unconfirmed` answer — and the dedup expiry repair does
  the same when its post-commit confirmation read fails. A later owner PUT,
  PATCH or DELETE and a later feed write to that id answer
  `503 write_outcome_unknown` until the process restarts.
