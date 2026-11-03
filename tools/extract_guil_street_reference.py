"""Produce a small, reproducible source subset; input is the locally held NGII dataset."""
from pathlib import Path
import hashlib
import json
import sys

from street_geometry import clean_ring

ORIGIN = (748.20765, 763.5115)  # Shared with the preserved Shinyeong model.
BOUNDS = (-65.0, -55.0, 55.0, 55.0)


def extract(source, output):
    if Path(output).exists():
        raise FileExistsError("Output exists; choose a new file to preserve existing observations")
    raw = Path(source).read_bytes()
    collection = json.loads(raw)
    metadata = collection.get("metadata", {})
    if metadata.get("sourceYear") != 2025 or metadata.get("scale") != "1:1000":
        raise ValueError("Unexpected source date or scale")
    if metadata.get("sourceSha256") != "f4081a9a33fa0f622ce7174fce5f2a3381291c5fba8d5c152a9e609f87ad7f43":
        raise ValueError("The NGII dataset is not aligned with the stored 2D map")
    selected = []
    for feature in collection["features"]:
        props = feature["properties"]
        kind = props.get("surfaceKind")
        local = props.get("local_geometry_m", {})
        if kind not in ("road_corridor", "walkway") or local.get("type") != "Polygon":
            continue
        rings = local.get("coordinates", [])
        if not rings:
            continue
        outer = [(x - ORIGIN[0], y - ORIGIN[1]) for x, y in clean_ring(rings[0])]
        xs, ys = [v[0] for v in outer], [v[1] for v in outer]
        if max(xs) < BOUNDS[0] or min(xs) > BOUNDS[2] or max(ys) < BOUNDS[1] or min(ys) > BOUNDS[3]:
            continue
        if len(rings) != 1:
            raise ValueError("Pilot region contains a polygon with holes; manual handling is required")
        selected.append({"id": feature["id"], "kind": kind, "ring_m": [[round(x, 6), round(y, 6)] for x, y in outer]})
    if not selected or not {f["kind"] for f in selected} == {"road_corridor", "walkway"}:
        raise ValueError("Pilot region does not contain both expected surface kinds")
    result = {
        "description": "2025 NGII 1:1000 road-corridor and walkway polygon subset, reference only; not a 2026 survey",
        "source_url": "https://map.ngii.go.kr/",
        "source_dataset_year": 2025,
        "source_dataset_scale": "1:1000",
        "source_dataset_sha256": hashlib.sha256(raw).hexdigest(),
        "source_plan_sha256": metadata["sourceSha256"],
        "shared_origin_local_m": list(ORIGIN),
        "axes": "x east, y north, z up; metres",
        "clip_bounds_m": list(BOUNDS),
        "limitations": ["Road corridor includes walkway; it is not verified asphalt width.", "2025 mapping is not a 2026 field survey.", "Sidewalk height, paving and neutral ground are visual placeholders.", "Roof-to-sidewalk gaps and inaccessible regions remain unverified."],
        "features": selected,
    }
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return result


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: python extract_guil_street_reference.py SOURCE.geojson OUTPUT.json")
    result = extract(sys.argv[1], sys.argv[2])
    print(json.dumps({"feature_count": len(result["features"]), "output": sys.argv[2]}, ensure_ascii=False))
