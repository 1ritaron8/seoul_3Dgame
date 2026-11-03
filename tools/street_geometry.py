"""Small, dependency-free geometry operations for the Guil street surface draft."""
from math import isfinite


def signed_area(vertices):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(vertices, vertices[1:] + vertices[:1])) / 2.0


def clean_ring(coordinates):
    vertices = []
    for point in coordinates:
        x, y = float(point[0]), float(point[1])
        if not isfinite(x) or not isfinite(y):
            raise ValueError("non-finite polygon coordinate")
        current = (x, y)
        if not vertices or current != vertices[-1]:
            vertices.append(current)
    if len(vertices) > 1 and vertices[0] == vertices[-1]:
        vertices.pop()
    if len(vertices) < 3 or abs(signed_area(vertices)) < 1e-7:
        raise ValueError("degenerate polygon ring")
    return vertices


def clip_polygon_to_rect(vertices, bounds):
    """Clip one convex input polygon against (min_x, min_y, max_x, max_y)."""
    min_x, min_y, max_x, max_y = bounds
    if not min_x < max_x or not min_y < max_y:
        raise ValueError("invalid clipping bounds")
    result = list(vertices)
    for axis, edge, keep_above in ((0, min_x, True), (0, max_x, False), (1, min_y, True), (1, max_y, False)):
        if not result:
            break
        out = []
        previous = result[-1]
        previous_inside = previous[axis] >= edge if keep_above else previous[axis] <= edge
        for current in result:
            current_inside = current[axis] >= edge if keep_above else current[axis] <= edge
            if current_inside != previous_inside:
                denominator = current[axis] - previous[axis]
                if abs(denominator) < 1e-15:
                    raise ValueError("unstable clipping intersection")
                t = (edge - previous[axis]) / denominator
                out.append((previous[0] + t * (current[0] - previous[0]), previous[1] + t * (current[1] - previous[1])))
            if current_inside:
                out.append(current)
            previous, previous_inside = current, current_inside
        result = out
    # Remove repeated vertices at boundaries to prevent degenerate triangles.
    deduped = []
    for vertex in result:
        if not deduped or (abs(vertex[0] - deduped[-1][0]) > 1e-9 or abs(vertex[1] - deduped[-1][1]) > 1e-9):
            deduped.append(vertex)
    if len(deduped) > 1 and abs(deduped[0][0] - deduped[-1][0]) < 1e-9 and abs(deduped[0][1] - deduped[-1][1]) < 1e-9:
        deduped.pop()
    return deduped if len(deduped) >= 3 and abs(signed_area(deduped)) > 1e-9 else []


def horizontal_intervals(vertices, y):
    """Return inside intervals for a horizontal line through one simple ring."""
    crossings = []
    for a, b in zip(vertices, vertices[1:] + vertices[:1]):
        if (a[1] <= y < b[1]) or (b[1] <= y < a[1]):
            crossings.append(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
    crossings.sort()
    if len(crossings) % 2:
        raise ValueError("odd number of polygon intersections")
    return list(zip(crossings[::2], crossings[1::2]))


def subtract_intervals(base_intervals, cut_intervals):
    remaining = list(base_intervals)
    for cut_a, cut_b in cut_intervals:
        parts = []
        for a, b in remaining:
            if cut_b <= a or cut_a >= b:
                parts.append((a, b))
            else:
                if a < cut_a:
                    parts.append((a, min(b, cut_a)))
                if cut_b < b:
                    parts.append((max(a, cut_b), b))
        remaining = parts
    return remaining


def clip_segment_to_rect(a, b, bounds):
    """Clip one line segment to a rectangle using Liang-Barsky."""
    min_x, min_y, max_x, max_y = bounds
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    for p, q in ((-dx, a[0] - min_x), (dx, max_x - a[0]), (-dy, a[1] - min_y), (dy, max_y - a[1])):
        if abs(p) < 1e-15:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None
    first = (a[0] + t0 * dx, a[1] + t0 * dy)
    last = (a[0] + t1 * dx, a[1] + t1 * dy)
    if abs(first[0] - last[0]) < 1e-9 and abs(first[1] - last[1]) < 1e-9:
        return None
    return first, last
