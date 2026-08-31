# wechat-cc GIPHY relay

The Worker keeps the GIPHY API key server-side. Desktop clients call `GET /search?q=...&limit=...` and never receive the key.

## Deploy once

```sh
npx wrangler login
npx wrangler secret put GIPHY_API_KEY
npx wrangler deploy
```

After deployment, the endpoint is:

```text
https://wechat-cc-giphy-relay.<your-account>.workers.dev/search
```

The desktop client can use that URL as its online sticker source. Do not commit the API key or put it in `wrangler.toml`.
