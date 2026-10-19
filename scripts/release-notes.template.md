Dreamcast DevTools {{version}} is the web debugger UI of nullDC, the Dreamcast emulator, built from the tag {{tag}} of this repository.

## Files

- `{{native_zip}}`: the native build (`dist-native`), which talks to the emulator over its WebSocket. It is the bundle an emulator build embeds and serves: unpack the zip and configure nullDC with `-DNULLDC_DEVTOOLS_DIST=<where it was unpacked>/{{native_folder}}/dist-native`.
- `{{wasm_zip}}`: the wasm build (`dist-wasm`), which talks over BroadcastChannels to an emulator that runs in the same browser. Any static file server can serve its folder `{{wasm_folder}}/dist-wasm`.
- `SHA256SUMS`: the SHA-256 of the two zips (`sha256sum -c SHA256SUMS`).

Each zip holds one folder, named like the zip, with the build and the UI's `LICENSE`. Each build's `bundle-info.json` gives its version, `{{version}}`, its protocol version and the SHA-256 of each of its files.

## The emulator

The emulator of the same version is the Release nullDC {{version}} of https://github.com/skmp/nulldc3 (its tag {{tag}}); its builds embed this `dist-native`.

## Licence

MIT: the `LICENSE` in each zip.
