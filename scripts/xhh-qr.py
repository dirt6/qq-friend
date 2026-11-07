# Render a QR code to SVG locally (no PIL). ASCII-only to avoid codepage issues.
# Usage: python scripts/xhh-qr.py <text> <out.svg>
import sys

import qrcode
import qrcode.image.svg

text = sys.argv[1]
out = sys.argv[2]

qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=10,
    border=4,
)
qr.add_data(text)
qr.make(fit=True)
img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
img.save(out)
print("ok " + out)
