# Contributing

The source is TypeScript. The published package contains dual CommonJS and ESM builds under `dist` because Node does not strip types from TypeScript files in `node_modules`.

## Development commands

```bash
npm run build
npm test
npm run prepublishOnly
```

`npm test` runs synthetic fixtures, real engine checks and a checksum-pinned public corpus when the network is available. Private-document checks skip unless their local inputs exist.

The package requires Node.js 22.13 or newer. This is the oldest measured runtime that supports both the PDF.js CommonJS loading path and the rendering APIs used by the package.
