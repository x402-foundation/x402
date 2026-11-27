The bazaar icon_url check now strips a trailing dot from the host and rejects hosts whose last label is numeric, so loopback forms such as localhost., 127.1 and 0177.0.0.1 are rejected.
