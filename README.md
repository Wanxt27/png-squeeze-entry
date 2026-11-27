# PNG Squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Wanxt27/png-squeeze-entry/rank.svg)](https://make.fun/c/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Wanxt27/png-squeeze-entry/reward.svg)](https://make.fun/c/png-squeeze-01-run-20261127)

A lossless PNG re-encoder for the [make.fun "Squeeze screenshots into the smallest PNG" bounty](https://make.fun/c/png-squeeze-01-run-20261127): one Node program that rewrites each 1280x720 RGBA screenshot as the smallest lossless PNG it can.

## How it works

`main.ts` reads each `/input/<id>/image.png`, decodes the stored PNG, and re-encodes it:

1. **Analyse** the pixels: distinct RGBA colours, whether every pixel is opaque, whether the image is greyscale.
2. **Pick the smallest exact representation**: palette (colour type 3) when there are at most 256 colours, greyscale (type 0) or grey+alpha (type 4) for grey images, RGB (type 2) when fully opaque, RGBA (type 6) otherwise. A fully transparent pixel's colour is always preserved exactly.
3. **Try every filter plan for real** — adaptive per-row choice by sum of |signed filtered byte|, adaptive by per-row entropy estimate, adaptive over {None, Paeth}, fixed Paeth, and each fixed filter — compress each with zlib level 9 and keep the smallest file. Screenshots repeat whole rows, so an unfiltered row often beats Paeth.
4. **Emit a minimal PNG**: IHDR, PLTE/tRNS only when needed, a single IDAT, IEND.

Only Node built-ins are used; nothing is installed. The program is fully deterministic: no clock, no randomness, no environment reads.

## Run

```sh
node main.ts   # reads /input/<id>/image.png, writes /output/<id>/image.png
```

## Practice-set result

Scored with the kit's own scorer on the practice set: **696,545** (all 8 instances exact, passed), versus **420,399** for the house fixed-paeth baseline — total 569,564 bytes against the baseline's 708,151, smaller on every one of the 8 instances. Two runs produce byte-identical output.
