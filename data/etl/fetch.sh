#!/usr/bin/env bash
# Fetch the boundary files the ETL needs. The speed data itself is not fetched
# here -- build.py downloads each quarter's parquet from the public bucket,
# processes it and deletes it again, so peak disk stays near 600 MB instead of
# the 15 GB the full archive would take.
#
# Usage:  bash data/etl/fetch.sh
# Then:   python data/etl/build.py

set -euo pipefail

RAW="$(cd "$(dirname "$0")/.." && pwd)/raw"
mkdir -p "$RAW"

# Country boundaries: Natural Earth 1:50m, public domain.
echo "==> country boundaries (Natural Earth 1:50m)"
curl -fsSL -o "${RAW}/ne_50m_countries.geojson" \
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson"

# Sub-national boundaries: geoBoundaries CGAZ, CC BY 4.0. These are large
# (~360 MB and ~550 MB) because they are full resolution; build.py simplifies
# them down to what the map actually needs.
for LEVEL in ADM1 ADM2; do
  echo "==> geoBoundaries CGAZ ${LEVEL}"
  curl -fsSL -o "${RAW}/cgaz_${LEVEL}.geojson" \
    "https://github.com/wmgeolab/geoBoundaries/raw/main/releaseData/CGAZ/geoBoundariesCGAZ_${LEVEL}.geojson"
done

echo
ls -lh "$RAW"/*.geojson
echo
echo "Next:  python data/etl/build.py"
