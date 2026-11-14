#!/usr/bin/env bash
# Descarga las librerias a libs/ (una sola vez, requiere internet).
cd "$(dirname "$0")" && mkdir -p libs libs/tesseract
bajar() { [ -s "$1" ] && { echo "Ya existe  $1"; return; }; echo "Bajando    $1"; curl -L --fail -s -o "$1" "$2" || { echo "  ERROR al bajar $1"; rm -f "$1"; }; }
bajar libs/html5-qrcode.min.js https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js
bajar libs/xlsx.full.min.js https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js
bajar libs/jspdf.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
bajar libs/jspdf.plugin.autotable.min.js https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js
bajar libs/firebase-app-compat.js https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js
bajar libs/firebase-auth-compat.js https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js
bajar libs/firebase-firestore-compat.js https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js
# lectura inteligente (OCR) sin internet
bajar libs/tesseract/tesseract.min.js https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
bajar libs/tesseract/worker.min.js https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js
bajar libs/tesseract/tesseract-core.wasm.js https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core.wasm.js
bajar libs/tesseract/tesseract-core-simd.wasm.js https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js
bajar libs/tesseract/tesseract-core-lstm.wasm.js https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js
bajar libs/tesseract/tesseract-core-simd-lstm.wasm.js https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js
bajar libs/tesseract/eng.traineddata.gz https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz
echo "Listo."
