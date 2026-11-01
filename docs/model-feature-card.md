# Model feature card

`ModelFeatureCard` shows a feature's model choice, data disclosure and confirmation before saving. The server remains responsible for refusing unavailable features, missing provider keys and unsupported modes.

## Return from adding a key

When the user confirms a choice but its provider has no key, the card stores the pending model and level in session storage. The key link opens Connections. The return destination keeps the original path, query and section hash, without the previous return-trip parameters.

After Connections saves the key and returns with `resume=<feature id>`, the card consumes the saved choice once. It can finish either a first switch-on or a provider change on an enabled feature. The current active model stays visible until the server confirms the change. A second resume while saving does not send another request.

Connections is delivered separately in pull request #32. No production feature becomes available merely because the card or Connections is merged. The real feature screen must use `makeHttpClient()`, and its disclosure and runner must be connected before readiness changes.
