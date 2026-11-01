# Return from adding a model provider key

A model feature can send the user to:

```text
/operations?provider=deepseek&resume=knowledge-update&returnTo=%2Foperations%3Ftab%3Dkb#systems/connections
```

Connections opens the named provider, including on an installation with an empty connections catalog. Supported providers are Anthropic, DeepSeek, OpenRouter, xAI and OpenAI. Local Ollama models do not need a key. Unknown providers leave the normal Connections list available.

The password field sends the key to the existing authenticated `/api/vault/sync-secrets` API. The form checks the saved key names before leaving. Failed saves keep the form open with an error. The form never puts a key into the URL, browser storage or an error message.

After saving, Connections returns to the local `returnTo` path and adds `resume=<feature id>`. Existing query parameters and the hash remain intact. External destinations are refused. Without a valid destination, the form confirms the save and stays open.

The receiving model feature card owns the pending model choice and its confirmation. Connections does not enable any feature or call a model provider. Feature readiness and Overwatch mode are unchanged.

## Verification

- URL tests cover local destinations, query and hash preservation, invalid destinations and supported providers.
- A headless browser checked the real Operations provider link and a save through the private file store using a disposable placeholder key.
- A browser check with simulated failures confirmed that a failed save stays on the form.
- The full Systems layout was checked at 360, 375, 480, 481, 768 and 1280 pixels, including reload and the phone navigation drawer. The phone layout uses one grid column when its sidebar is hidden. The Connections breadcrumb returns to the list without reopening the provider.

The model feature API and card are separate changes. Their combined deployment still needs verification before features become available.
