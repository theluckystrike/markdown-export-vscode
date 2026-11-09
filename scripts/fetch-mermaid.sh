#!/bin/sh
# Mermaid ships as one prebuilt file (MIT). Fetched at build time only; the extension never downloads anything.
set -e
cd "$(dirname "$0")/.."
mkdir -p media/vendor
curl -sSfL -o media/vendor/mermaid.min.js https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.min.js
curl -sSfL -o media/vendor/mermaid.LICENSE https://cdn.jsdelivr.net/npm/mermaid@12.3.0/LICENSE
