- **The CLI's shared REST helper now reports a failed request with a bounded one-line reason instead of the whole response body.**
  Apart from a refused redirect and a credential-less 403, which keep their own
  messages, the message reads `HTTP <status>`, then the JSON body's `error`,
  `code` or `message` string, or else an excerpt of the body. Either is one
  line: line breaks become spaces, other control characters are removed, and
  text past 200 characters is cut and marked `...`. When the helper builds that
  message from a response body it read and `FLAIR_DEBUG` is set, it also writes
  that body to stderr as received, encoded as one JSON string (#2764).

  An HTTP error response whose body mentions `fetch failed` or `unable to
  connect` is no longer treated as a failed connection: the CLI no longer
  retries it on the port in `~/.flair/config.yaml` or reports the instance as
  unreachable.
