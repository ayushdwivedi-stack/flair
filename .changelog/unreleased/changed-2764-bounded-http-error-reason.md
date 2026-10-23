- **The CLI's shared REST helper now reports a failed request with a bounded one-line reason instead of the whole response body.**
  Apart from a refused redirect and a credential-less 403, which keep their own
  messages, the message reads `HTTP <status>`, then the JSON body's `error`,
  `code` or `message` string, or else an excerpt of the body. Either is one
  line: line breaks become spaces, other control characters are removed, and
  text past 200 characters is cut to at most 200 and marked `...`, unless
  `...` would itself match a credential value the request sent. When the
  helper builds that message from a response body it read and `FLAIR_DEBUG` is
  set, it also writes that body to stderr, encoded as one JSON string (#2764).

  The message and that stderr line replace the credential values the request
  sent (the Authorization header value, the part after its scheme, a Basic
  header's decoded `user:password` and password, a TPS-Ed25519 signature)
  with `[redacted]`; the `HTTP <status>` prefix is not changed. The stderr
  line shows a JSON body re-serialized (withheld when it parses as JSON but
  cannot be redacted and re-serialized) and the request path percent-decoded
  (withheld when it does not decode or holds a control character). Redaction
  covers a response that repeats the request's credential values literally,
  inside any JSON string (whatever escaping the JSON uses), or percent-encoded
  (either hex case). A server that transforms a credential some other way is
  not covered; that server already received the credential.

  An HTTP error response whose body mentions `fetch failed` or `unable to
  connect` is no longer treated as a failed connection: the CLI no longer
  retries it on the port in `~/.flair/config.yaml` or reports the instance as
  unreachable.
