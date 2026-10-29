# From source

Requires Node 22.13 or newer (for the built-in `node:sqlite`):

```bash
cd dashboard
npm ci && npm run build
cp -r .next/static .next/standalone/.next/static
PADDOCK_DATA_DIR=../data PORT=8080 node .next/standalone/server.js
```

Development: `cd dashboard && npm install && PADDOCK_DATA_DIR=../data npm run dev`.
