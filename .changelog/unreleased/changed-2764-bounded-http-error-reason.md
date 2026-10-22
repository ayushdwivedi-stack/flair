- **The CLI's shared REST helper now reports a failed request with a bounded one-line reason instead of the whole response body.**
  The message reads `HTTP <status>`, then the JSON body's `error`, `code` or
  `message` string, or else an excerpt of the body. Either is one line: line
  breaks become spaces, other control characters are removed, and text past 200
  characters is cut and marked `...`. With `FLAIR_DEBUG` set, the helper also
  writes that full response body to stderr. The no-credentials 403 hint is
  unchanged (#2764).
